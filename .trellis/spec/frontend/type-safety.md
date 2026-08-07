# Frontend Type Safety

## TypeScript Baseline

TypeScript strict mode is required. Network, storage, and parsed Markdown
boundaries are untrusted until decoded.

Evidence:

- MVP `design.md` section 4;
- shared cross-layer thinking guide.

## Type Ownership

- API DTO types and decoders live in `lib/api`.
- SSE variants live beside the SSE decoder.
- Feature view models live with the owning feature.
- Component-only props stay in the component unless shared.
- Do not manually duplicate an API shape in multiple components.

Database schema and Rust internal types are not copied into the frontend unless
they are part of the public API contract.

## Boundary Decoding

Parse JSON as `unknown`, then validate:

- required fields;
- discriminant values;
- integer timestamp shape;
- arrays and nullable fields;
- model/conversation/message IDs as bounded strings.

The validation mechanism should be small. A runtime-schema dependency requires a
documented size/maintenance justification; focused type guards are acceptable
when centralized and thoroughly tested.

## Discriminated Unions

Use unions for:

- session status;
- message status;
- generation UI status;
- SSE events;
- normalized API errors.

Exhaustive switches must fail type-check when a variant is added.

## Forbidden Patterns

- `any`;
- unchecked `as SomeType` on network or localStorage values;
- non-null assertions on asynchronously loaded state;
- string comparison against ad hoc error messages;
- components defining private copies of event/API interfaces;
- using model names to infer capabilities.

An assertion is allowed only after a central decoder or for a proven
compile-time invariant, with a short explanation when not obvious.

## Contract Changes

Any public field or event change updates in one slice:

1. Rust DTO/event owner;
2. frontend decoder and type;
3. producer test;
4. consumer test;
5. relevant task/spec documentation.

