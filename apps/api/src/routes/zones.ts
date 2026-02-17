import { Router } from "express";
import { hasuraQuery } from "../hasura.js";

export const zonesRouter = Router();

const ZONES_QUERY = `
  query {
    alarmdata_person_safe_spot(
      where: {safe_spot_type: {_in: ["ZONE", "PSEUDO_ZONE"]}
     # , is_public: {_eq: true}
      },
    ) {
      id
      name
      pss_image { s3_location }
      area_json
      created_at
      description
      is_active
      is_public
      max_number_of_members_allowed
      modified_at
      number_of_members
      number_of_members_reachable
      safe_spot_type
      valid_until
      about
      person {
        person_account {
        display_name
      }
    }
    }
  }
`;

interface ZoneRow {
  id: string;
  name: string;
  pss_image: { s3_location: string } | null;
  area_json: unknown;
  created_at: string;
  description: string | null;
  is_active: boolean;
  is_public: boolean;
  max_number_of_members_allowed: number | null;
  modified_at: string;
  number_of_members: number;
  number_of_members_reachable: number;
  safe_spot_type: string;
  valid_until: string | null;
  about: string | null;
  person: { person_account: { display_name: string } | null } | null;
}

interface ZonesQueryResult {
  alarmdata_person_safe_spot: ZoneRow[];
}

const ZONES_TTL_MS = 5 * 60 * 1000;
let zonesCache: { data: ZoneRow[]; expiresAt: number } | null = null;

zonesRouter.get("/zones", async (_req, res) => {
  try {
    if (zonesCache && Date.now() < zonesCache.expiresAt) {
      res.json({ zones: zonesCache.data });
      return;
    }
    const data = await hasuraQuery<ZonesQueryResult>(ZONES_QUERY);
    zonesCache = { data: data.alarmdata_person_safe_spot, expiresAt: Date.now() + ZONES_TTL_MS };
    res.json({ zones: zonesCache.data });
  } catch (err) {
    console.error("Zones fetch failed:", err);
    res.status(500).json({ error: "Failed to fetch zones" });
  }
});
