# Agent Notes

## Code Structure and Naming

Prefer domain-oriented modules over generic implementation-oriented names. Name a module after the concrete concept it owns: use names such as `plugins.ts` and `event-sources.ts` rather than broad names such as `loader.ts` or `event.ts`.

When a domain grows beyond one cohesive file, keep its public facade in `<domain>/index.ts` and place stateful subsystems in focused sibling modules. The facade should retain the public API, compose the subsystems, and delegate to them through short domain-named fields such as `plugins`, `apiHooks`, `eventSources`, `timers`, and `lifecycle`.

Use plural filenames for modules that own collections or registries, for example:

- `plugins.ts`
- `timers.ts`
- `api-hooks.ts`
- `event-sources.ts`

Use a singular filename for a coordinating concept or state machine, such as `lifecycle.ts`.

Inside a domain directory, avoid repeating the parent domain in every type name. Prefer `PluginRegistry`, `HookRegistry`, `EventSourceRegistry`, and `TimerRegistry` over names prefixed with `Context`. Use `Registry` for an object that owns and operates on a collection of resources. Reserve `Manager` for orchestration across components or lifecycle phases. At a composition boundary, an import alias may describe the local role more directly, for example `HookRegistry as ApiHookManager`.

Keep behavior with the state it governs. A registry should own its collection, validation, and cleanup rules; lifecycle coordination should own ordering and state transitions. Keep pure, subsystem-specific helpers module-local rather than adding them to the facade.

Prefer composition and explicit constructor dependencies over exposing another class's private state. Do not introduce shared symbols solely to bypass module boundaries when a small registry or manager can own the state directly. If symbols are genuinely necessary, centralize them in a dedicated `symbol.ts` module.

Internal subsystem modules should not be re-exported from the package barrel unless they are intentionally part of the public API. Preserve stable imports through the domain facade.

## Method Extraction and Inlining

Do not extract a private method merely to shorten its caller or narrate each implementation step. A one-use method should usually be inlined when its name only restates the mechanics of its body, such as collecting a temporary map, checking one local condition, forwarding arguments, wrapping one callback, or running one loop for its sole caller. Keep these details together so the complete workflow can be read without jumping through a chain of names that are themselves implementation details.

Inline especially when a helper:

- has exactly one caller and no independent domain meaning;
- only forwards to another method or adapts arguments once;
- exists only to work around local control-flow or typing;
- splits one loop, branch, or lifecycle phase into a thin call chain;
- does not own state, enforce a reusable invariant, or establish an error boundary.

Do not use method count or line count alone as a reason to extract. Prefer one cohesive method with visible local control flow over many tiny methods whose names must be opened to understand what actually happens.

A single-call method may remain extracted when it represents a real boundary: a recursive operation, a complete stateful or cancellable protocol, a reusable invariant, a substantial domain algorithm, a distinct error-handling boundary, or logic that can be understood and tested independently. For a large stateful concern, prefer moving the concern into a focused registry or manager that owns its state instead of decomposing it into one-use methods on the facade.

Method names should express domain intent, not merely translate implementation into prose. If a useful name cannot say more than the body already says, keep the code at the call site.

## Frontend Design

Prefer a restrained, Stripe-like visual language: clear hierarchy, precise spacing, strong typography, subtle borders and shadows, and a small purposeful color palette. Interfaces should feel polished through proportion and alignment rather than through decoration.

Remove copy and visual elements that do not help the user complete the current task. Avoid explanatory panels, feature callouts, ornamental backgrounds, oversized headings, redundant security text, and decorative footer content in focused application flows. Do not turn a simple form into a marketing page.

For a single-purpose flow such as authentication, use a compact single-column layout and center the complete interaction area in the viewport. Keep the primary input and action visually dominant. The layout should remain centered and free of overflow on narrow screens and when validation or loading states appear.

Use concise, direct labels and actions. Add helper text only when the user needs it to make a decision or recover from an error. Prefer visible field labels, clear inline validation, and familiar icons over instructional prose.

When shadcn/ui is used, add components through the shadcn CLI with the project's selected preset instead of recreating them manually. Compose and restyle those primitives to fit the product, while preserving accessible labels, focus states, disabled states, and predictable form behavior.

## Testing

Prefer narrow, direct commands that avoid triggering pnpm's package-script dependency checks.

For core service/plugin behavior, run the target test file directly. For example, to test `service`:

```bash
pnpm exec tsx --test packages/fraq/test/service.test.ts
```

This is lower impact than:

```bash
pnpm --filter @fraqjs/fraq test
```

The filtered package script can trigger pnpm install/status checks, including `node_modules` recreation prompts and registry access. Use the direct `tsx --test` form when a focused test file is enough.

For type checking without build output, for example to check `core`:

```bash
pnpm exec tsc -p packages/fraq/tsconfig.json --noEmit
```

For Biome checks, scope the command to changed files, for example:

```bash
pnpm exec biome check packages/fraq/src/core/context/index.ts packages/fraq/src/core/context/plugins.ts packages/fraq/test/service.test.ts
```

Adjust the file list to match the current change. Avoid broad checks unless the change genuinely needs them.
