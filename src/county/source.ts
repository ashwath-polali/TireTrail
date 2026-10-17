export type Role = 'drain' | 'junction' | 'outfall' | 'discharge' | 'facility-hold' | 'facility-infiltrate' | 'pipe' | 'ditch' | 'culvert' | 'stream-culvert' | 'virtual' | 'stream';
export type Trust = 'id' | 'inverts' | 'compass' | 'node-flags' | 'digitized' | 'none';
export interface SourceAsset {
  role: Role;
  id: string;            // the source's own asset id (never an address or a name of a person or business)
  src: string;           // source key, e.g. 'tacoma'
  key?: string;          // node key carried by a point, for id-graph joins
  fromId?: string;       // upstream node key of a line (after orientation)
  toId?: string;         // downstream node key of a line
  coords: [number, number][]; // lon/lat; a point has one; a line is in FLOW ORDER when trust != 'none'; a facility polygon is its outer ring
  trust: Trust;          // how sure the flow order is
  width?: number;        // meters
  perforated?: boolean;
  openBottom?: boolean;
  owner?: 'public' | 'private' | 'other'; // a category only
  liveStream?: boolean;  // carries a natural stream
  endHint?: 'water' | 'ground' | 'treatment' | 'unknown' | string; // outfalls/discharges; 'handoff:<agency>' for water handed to another system
  receivingHint?: string; // receiving water or basin name as recorded by the source
  system?: 'separated' | 'combined' | 'partially-separated'; // sewer system type at this asset (Seattle)
  upInv?: number; downInv?: number; // meters, where known
}
export interface SourceMeta { key: string; name: string; county: 'King' | 'Pierce'; credit: string; disclaimer?: string; fetchedAt: string; boundary: [number, number][][][]; counts: Record<string, number>; notes: string[] }
