/**
 * Shared model identity for unit-test fixtures.
 *
 * Deliberately a fixed constant: jsdom unit tests must not depend on the
 * machine they run on. Deriving this from the repo-root `.env`
 * (`AI_DEFAULT_MODEL`) made the fixture value differ between a dev box that
 * has `.env` and CI that does not — harmless while the value is an opaque
 * string, but a latent source of "green locally, red in CI" the moment an
 * assertion depends on its shape (e.g. the display-name derivation in
 * `lib/models/model-label.ts`).
 *
 * The value matches the placeholder used by the Rust config tests
 * (`crates/server/src/config.rs`), so frontend and backend fixtures agree.
 * Verification against a real provider model belongs in integration tests,
 * not here.
 */
export const TEST_MODEL_ID = "test-model";
