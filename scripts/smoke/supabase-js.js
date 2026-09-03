/** The dev-mock smoke flow never constructs a real supabase client — env vars
 * are absent, so supabase.ts sets `supabase = null` and every call routes to
 * devMock. This stub only needs to satisfy the import (createClient exists). */
module.exports = {
  createClient: () => {
    throw new Error('smoke harness: real supabase client not available (dev mock flow)');
  },
};