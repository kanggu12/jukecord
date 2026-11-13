/**
 * The version of jukecord, kept in this one place.
 *
 * package.json, the Helm chart and the container image carry the same number, and a packaging test fails when one
 * of them drifts from it. Releases follow Semantic Versioning; the tag that publishes one is `v` followed by this value.
 */
export const VERSION = '0.3.1';
