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

export interface ZoneRow {
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
let zonesMapCache: { map: Map<string, ZoneRow>; expiresAt: number } | null = null;

async function ensureZonesCache() {
  if (zonesCache && Date.now() < zonesCache.expiresAt) return;
  const data = await hasuraQuery<ZonesQueryResult>(ZONES_QUERY);
  zonesCache = { data: data.alarmdata_person_safe_spot, expiresAt: Date.now() + ZONES_TTL_MS };
  zonesMapCache = null; // invalidate map cache
}

/** Returns all zones keyed by zone id (pss_id) for O(1) lookup. */
export async function getZonesMap(): Promise<Map<string, ZoneRow>> {
  await ensureZonesCache();
  if (!zonesMapCache || zonesMapCache.expiresAt !== zonesCache!.expiresAt) {
    const map = new Map<string, ZoneRow>();
    for (const z of zonesCache!.data) map.set(z.id, z);
    zonesMapCache = { map, expiresAt: zonesCache!.expiresAt };
  }
  return zonesMapCache.map;
}

zonesRouter.get("/zones", async (_req, res) => {
  try {
    await ensureZonesCache();
    res.json({ zones: zonesCache!.data });
  } catch (err) {
    console.error("Zones fetch failed:", err);
    res.status(500).json({ error: "Failed to fetch zones" });
  }
});
