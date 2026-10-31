// Optional resource profile. These bindings are absent from the core Wrangler configuration.
declare namespace Cloudflare {
  interface Env { BUCKET?: R2Bucket; }
}
