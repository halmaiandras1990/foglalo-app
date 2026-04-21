const express = require("express");
const path = require("path");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ----- ALAP KONFIG -----
// FONTOS:
// Itt már többféle foglalási módra készülünk.
// bookingMode lehet:
// - fixed_slots
// - interval_slots
// - rolling_slots
const CONFIG = {
  bookingMode: "fixed_slots",

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

  // INTERVAL módhoz
  startIntervalMinutes: 60,

  services: {
    gel_lakk: { label: "Gél lakk", duration: 90 },
    epites: { label: "Építés", duration: 180 },
    toltes: { label: "Töltés", duration: 120 },
    manikur: { label: "Manikűr", duration: 45 },
    pedikur: { label: "Pedikűr", duration: 60 },
    lab_gellakk: { label: "Láb gél lakk", duration: 120 },
    kez_lab_apolas: { label: "Kéz + láb ápolás", duration: 240 }
  },

  // FIXED SLOTS módhoz
  // napokra bontott, előre definiált indulási időpontok
  fixedSlots: {
    1: ["08:00", "10:30", "13:00", "16:00"], // hétfő
    2: ["08:00", "10:30", "13:00"],          // kedd
    3: ["08:00", "10:30", "13:00", "16:00"], // szerda
    4: ["08:00", "10:30", "13:00"],          // csütörtök
    5: ["08:00", "10:30", "13:00", "16:00"]  // péntek
  }
};

// Ideiglenes memóriában tárolt foglalások
const bookings = [];

// ----- SEGÉDFÜGGVÉNYEK -----
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

function getDayBookings(date) {
  return bookings
    .filter((b) => b.date === date)
    .map((b) => ({
      start: toMinutes(b.start),
      end: toMinutes(b.end) + CONFIG.bufferMinutes
    }));
}

function getBreakRanges() {
  return CONFIG.breaks.map((b) => ({
    start: toMinutes(b.start),
    end: toMinutes(b.end)
  }));
}

function isSlotValid(slotStart, slotEnd, dayBookings, breakRanges) {
  const overlapsBreak = breakRanges.some((br) =>
    overlaps(slotStart, slotEnd, br.start, br.end)
  );
  if (overlapsBreak) return false;

  const overlapsBooking = dayBookings.some((bk) =>
    overlaps(slotStart, slotEnd, bk.start, bk.end)
  );
  if (overlapsBooking) return false;

  return true;
}

// ----- FOGALÁSI MÓDOK -----

// 1) FIXED SLOTS
function getAvailableSlotsFixed(date, serviceKey) {
  const weekday = getWeekdayFromDate(date);
  const fixedStarts = CONFIG.fixedSlots[weekday] || [];

  const service = CONFIG.services[serviceKey];
  if (!service) return [];

  const totalDuration = service.duration + CONFIG.bufferMinutes;
  const dayBookings = getDayBookings(date);
  const breakRanges = getBreakRanges();

  const slots = [];

  for (const startStr of fixedStarts) {
    const slotStart = toMinutes(startStr);
    const slotEnd = slotStart + totalDuration;

    if (!isSlotValid(slotStart, slotEnd, dayBookings, breakRanges)) {
      continue;
    }

    slots.push({
      start: startStr,
      end: toTimeString(slotStart + service.duration)
    });
  }

  return slots;
}

// 2) INTERVAL SLOTS
function getAvailableSlotsInterval(date, serviceKey) {
  const weekday = getWeekdayFromDate(date);
  const dayHours = CONFIG.workingHours[weekday];
  if (!dayHours) return [];

  const service = CONFIG.services[serviceKey];
  if (!service) return [];

  const serviceDuration = service.duration;
  const totalDuration = service.duration + CONFIG.bufferMinutes;

  const dayStart = toMinutes(dayHours.start);
  const lastStart = toMinutes(dayHours.end);

  const dayBookings = getDayBookings(date);
  const breakRanges = getBreakRanges();

  const slots = [];

  for (
    let slotStart = dayStart;
    slotStart <= lastStart;
    slotStart += CONFIG.startIntervalMinutes
  ) {
    const slotEnd = slotStart + totalDuration;

    if (!isSlotValid(slotStart, slotEnd, dayBookings, breakRanges)) {
      continue;
    }

    slots.push({
      start: toTimeString(slotStart),
      end: toTimeString(slotStart + serviceDuration)
    });
  }

  return slots;
}

// 3) ROLLING SLOTS
function getAvailableSlotsRolling(date, serviceKey) {
  const weekday = getWeekdayFromDate(date);
  const dayHours = CONFIG.workingHours[weekday];
  if (!dayHours) return [];

  const service = CONFIG.services[serviceKey];
  if (!service) return [];

  const serviceDuration = service.duration;
  const totalDuration = service.duration + CONFIG.bufferMinutes;

  const dayStart = toMinutes(dayHours.start);
  const lastStart = toMinutes(dayHours.end);

  const dayBookings = getDayBookings(date).sort((a, b) => a.start - b.start);
  const breakRanges = getBreakRanges().sort((a, b) => a.start - b.start);

  const slots = [];
  let current = dayStart;

  while (current <= lastStart) {
    const slotStart = current;
    const slotEnd = slotStart + totalDuration;

    const overlappingBreak = breakRanges.find((br) =>
      overlaps(slotStart, slotEnd, br.start, br.end)
    );

    if (overlappingBreak) {
      current = overlappingBreak.end;
      continue;
    }

    const overlappingBooking = dayBookings.find((bk) =>
      overlaps(slotStart, slotEnd, bk.start, bk.end)
    );

    if (overlappingBooking) {
      current = overlappingBooking.end;
      continue;
    }

    slots.push({
      start: toTimeString(slotStart),
      end: toTimeString(slotStart + serviceDuration)
    });

    current = slotStart + totalDuration;
  }

  return slots;
}

// ----- KÖZPONTI SLOT VÁLASZTÓ -----
function getAvailableSlots(date, serviceKey) {
  if (CONFIG.bookingMode === "fixed_slots") {
    return getAvailableSlotsFixed(date, serviceKey);
  }

  if (CONFIG.bookingMode === "interval_slots") {
    return getAvailableSlotsInterval(date, serviceKey);
  }

  if (CONFIG.bookingMode === "rolling_slots") {
    return getAvailableSlotsRolling(date, serviceKey);
  }

  return [];
}

// ----- API-k -----

// Szolgáltatások lekérése
app.get("/api/services", (req, res) => {
  res.json(CONFIG.services);
});

// Opcionális: debug, hogy lásd melyik mód fut
app.get("/api/config", (req, res) => {
  res.json({
    bookingMode: CONFIG.bookingMode,
    startIntervalMinutes: CONFIG.startIntervalMinutes,
    fixedSlots: CONFIG.fixedSlots
  });
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
    const adminResult = await resend.emails.send({
      from: "Foglalás <onboarding@resend.dev>",
      to: ["halmai.andras1990@gmail.com"], // teszt módban csak ez fog menni
      subject: "ADMIN TESZT - Új foglalás érkezett",
      html: `
        <h2>Új foglalás</h2>
        <p><b>Név:</b> ${name}</p>
        <p><b>Telefon:</b> ${phone}</p>
        <p><b>Szolgáltatás:</b> ${serviceDef.label}</p>
        <p><b>Dátum:</b> ${date}</p>
        <p><b>Időpont:</b> ${start}</p>
      `
    });

    console.log("ADMIN EMAIL RESULT:", adminResult);

    if (adminResult?.error) {
      console.error("ADMIN EMAIL HIBA:", adminResult.error);
    }

    if (email) {
      const guestResult = await resend.emails.send({
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

      console.log("GUEST EMAIL RESULT:", guestResult);

      if (guestResult?.error) {
        console.error("GUEST EMAIL HIBA:", guestResult.error);
      }
    }
  } catch (err) {
    console.error("EMAIL KÜLDÉSI KIVÉTEL:", err);
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
