const express = require("express");
const path = require("path");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ----- Anita alap beállításai -----
const CONFIG = {
  workingHours: {
    1: { start: "08:00", end: "16:00" }, // hétfő
    2: { start: "08:00", end: "13:00" }, // kedd
    3: { start: "08:00", end: "16:00" }, // szerda
    4: { start: "08:00", end: "13:00" }, // csütörtök
    5: { start: "08:00", end: "16:00" }  // péntek
  },
  breaks: [
    { start: "12:30", end: "13:00" }
  ],
  bufferMinutes: 10,
  slotStepMinutes: 30,
  services: {
    gel_lakk: { label: "Gél lakk", duration: 90 },
    epites: { label: "Építés", duration: 180 },
    toltes: { label: "Töltés", duration: 120 },
    manikur: { label: "Manikűr", duration: 45 },
    pedikur: { label: "Pedikűr", duration: 60 },
    lab_gellakk: { label: "Láb gél lakk", duration: 120 },
    kez_lab_apolas: { label: "Kéz + láb ápolás", duration: 240 }
  }
};

// Ideiglenes memóriában tárolt foglalások
// Később ezt lecseréljük Google Calendar + adatbázis kombóra
const bookings = [];

// ----- Segédfüggvények -----
function toMinutes(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function toTimeString(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function getWeekdayFromDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.getDay(); // vasárnap=0, hétfő=1, ...
}

function getAvailableSlots(date, serviceKey) {
  const weekday = getWeekdayFromDate(date);
  const dayHours = CONFIG.workingHours[weekday];
  if (!dayHours) return [];

  const service = CONFIG.services[serviceKey];
  if (!service) return [];

  const totalDuration = service.duration + CONFIG.bufferMinutes;
  const dayStart = toMinutes(dayHours.start);
  const dayEnd = toMinutes(dayHours.end);

  const dayBookings = bookings
    .filter((b) => b.date === date)
    .map((b) => ({
      start: toMinutes(b.start),
      end: toMinutes(b.end) + CONFIG.bufferMinutes
    }));

  const breakRanges = CONFIG.breaks.map((b) => ({
    start: toMinutes(b.start),
    end: toMinutes(b.end)
  }));

  const slots = [];

  for (
    let slotStart = dayStart;
    slotStart + totalDuration <= dayEnd;
    slotStart += CONFIG.slotStepMinutes
  ) {
    const slotEnd = slotStart + totalDuration;

    const overlapsBreak = breakRanges.some((br) =>
      overlaps(slotStart, slotEnd, br.start, br.end)
    );
    if (overlapsBreak) continue;

    const overlapsBooking = dayBookings.some((bk) =>
      overlaps(slotStart, slotEnd, bk.start, bk.end)
    );
    if (overlapsBooking) continue;

    slots.push({
      start: toTimeString(slotStart),
      end: toTimeString(slotStart + service.duration)
    });
  }

  return slots;
}

// ----- API-k -----

// Szolgáltatások lekérése
app.get("/api/services", (req, res) => {
  res.json(CONFIG.services);
});

// Szabad slotok lekérése
app.get("/api/slots", (req, res) => {
  const { date, service } = req.query;

  if (!date || !service) {
    return res.status(400).json({ error: "Hiányzik a date vagy service paraméter." });
  }

  const slots = getAvailableSlots(date, service);
  res.json(slots);
});

// Foglalás
app.post("/api/book", async (req, res) => {
  const { name, phone, email, service, date, start } = req.body;

  if (!name || !phone || !service || !date || !start) {
    return res.status(400).json({ error: "Hiányzó mezők." });
  }

  const serviceDef = CONFIG.services[service];
  if (!serviceDef) {
    return res.status(400).json({ error: "Érvénytelen szolgáltatás." });
  }

  const availableSlots = getAvailableSlots(date, service);
  const selectedSlot = availableSlots.find((s) => s.start === start);

  if (!selectedSlot) {
    return res.status(409).json({ error: "Ez az időpont már nem foglalható." });
  }

  const booking = {
    id: Date.now().toString(),
    name,
    phone,
    email: email || "",
    service,
    date,
    start,
    end: selectedSlot.end
  };

  bookings.push(booking);

  try {
    // Anita / admin értesítése
    await resend.emails.send({
      from: "Foglalás <onboarding@resend.dev>",
      to: ["IDE_A_SAJAT_EMAIL_CIMED"],
      subject: "Új foglalás érkezett",
      html: `
        <h2>Új foglalás</h2>
        <p><b>Név:</b> ${name}</p>
        <p><b>Telefon:</b> ${phone}</p>
        <p><b>Szolgáltatás:</b> ${serviceDef.label}</p>
        <p><b>Dátum:</b> ${date}</p>
        <p><b>Időpont:</b> ${start}</p>
      `
    });

    // Vendég visszaigazolás, ha van email
    if (email) {
      await resend.emails.send({
        from: "Foglalás <onboarding@resend.dev>",
        to: [email],
        subject: "Foglalás visszaigazolás",
        html: `
          <h2>Sikeres foglalás</h2>
          <p>Köszönjük a foglalást.</p>
          <p><b>Szolgáltatás:</b> ${serviceDef.label}</p>
          <p><b>Dátum:</b> ${date}</p>
          <p><b>Időpont:</b> ${start}</p>
        `
      });
    }
  } catch (err) {
    console.error("Email hiba:", err);
  }

  res.json({
    success: true,
    booking
  });
});

// Teszt: foglalások listája
app.get("/api/bookings", (req, res) => {
  res.json(bookings);
});

app.listen(PORT, () => {
  console.log(`Server fut a ${PORT} porton`);
});
