import "../env.js";
import { prisma } from "@heatbrothers/db";

const cities = [
  { name: "Berlin", lat: 52.52, lng: 13.405, weight: 600 },
  { name: "Hamburg", lat: 53.5511, lng: 9.9937, weight: 500 },
  { name: "Munich", lat: 48.1351, lng: 11.582, weight: 550 },
  { name: "Cologne", lat: 50.9375, lng: 6.9603, weight: 400 },
  { name: "Frankfurt", lat: 50.1109, lng: 8.6821, weight: 450 },
  { name: "Stuttgart", lat: 48.7758, lng: 9.1829, weight: 350 },
  { name: "Dusseldorf", lat: 51.2277, lng: 6.7735, weight: 300 },
  { name: "Leipzig", lat: 51.3397, lng: 12.3731, weight: 250 },
  { name: "Kiel", lat: 54.3233, lng: 10.1228, weight: 200 },
  { name: "Hannover", lat: 52.3759, lng: 9.732, weight: 280 },
  { name: "Vienna", lat: 48.2082, lng: 16.3738, weight: 300 },
  { name: "Zurich", lat: 47.3769, lng: 8.5417, weight: 250 },
];

const eventTypes = [
  "FIRST_TIME_PHONE_STATUS_SENT",
  "DETAILED_ALARM_STARTED_PRIVATE_GROUP",
  "DETAILED_ALARM_STARTED_PRIVATE_ZONE",
];

// Clean previous seed data
await prisma.event.deleteMany({
  where: { posthogId: { startsWith: "seed_" } },
});

const now = Math.floor(Date.now() / 1000);
const ninetyDaysAgo = now - 90 * 24 * 60 * 60;

const records: Parameters<typeof prisma.event.createMany>[0]["data"] = [];

for (const city of cities) {
  for (let i = 0; i < city.weight; i++) {
    for (const eventType of eventTypes) {
      const lat = city.lat + (Math.random() - 0.5) * 0.6;
      const lng = city.lng + (Math.random() - 0.5) * 0.6;
      const timestamp =
        ninetyDaysAgo + Math.floor(Math.random() * (now - ninetyDaysAgo));

      records.push({
        posthogId: `seed_${city.name}_${eventType}_${i}`,
        eventType,
        latitude: lat,
        longitude: lng,
        timestamp,
        city: city.name,
        country: "Seed",
        properties: JSON.stringify({ latitude: lat, longitude: lng }),
      });
    }
  }
}

// Batch insert in chunks (SQLite variable limit)
const CHUNK_SIZE = 500;
let inserted = 0;

for (let i = 0; i < records.length; i += CHUNK_SIZE) {
  const chunk = records.slice(i, i + CHUNK_SIZE);
  await prisma.event.createMany({ data: chunk });
  inserted += chunk.length;
}

console.log(`Seeded ${inserted} events across ${cities.length} cities.`);
process.exit(0);
