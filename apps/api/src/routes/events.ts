import { Router } from "express";
import { getEventsByType } from "../cache.js";

export const eventsRouter = Router();

eventsRouter.get("/events/:type", (req, res) => {
  const events = getEventsByType(req.params.type);
  res.json({
    count: events.length,
    events: events.map((e) => [e.longitude, e.latitude, 1]),
  });
});
