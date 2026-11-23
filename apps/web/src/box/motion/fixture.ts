import raw from "../../../public/box/anim/pack.json";
import { parsePack, type RawPack } from "./pack";

/**
 * The real pack, for tests only: imported from the file the game fetches.
 * Game code must use `loadPack` instead, or the clips would be bundled into
 * the page's script.
 */
export const RAW_PACK = raw as unknown as Omit<RawPack, "clips"> & { clips: { id: string; data: string }[] };
export const TEST_PACK = parsePack(RAW_PACK);
