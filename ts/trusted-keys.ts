// Public keys trusted to sign MUSE Aegis audit entries. Public information; safe to commit.
// This list must live in source control (not in the database that holds the log), so adding a key
// leaves a visible, dated change in the repository history. Keep it identical to spec/trusted-keys.json.
export const TRUSTED_KEYS: Record<string, JsonWebKey> = {
  "aegis-audit-2026-10": {
    crv: "P-256",
    ext: true,
    key_ops: ["verify"],
    kty: "EC",
    x: "4LRmQ8jxhaQW1WP0qkJlqZ_VhW2b9M283rtvG7Xrb9A",
    y: "7mIIilJjuqLtbEOU9aY7jPInI_j-M8oj-bxHwDHOmPQ",
  },
};
