# Fraq Logo

The mark is an F with a detached, diagonal terminal. The continuous stem
represents the common context; the separate terminal expresses composable
plugins. The 45-degree cut adds a restrained sense of rhythm. This is a visual
interpretation of the project, not a claim about the origin of its name.

The custom Fraq wordmark replaces the initial F with the standalone mark:
use [F] alone or [F]raq together, never [F] Fraq. Its q repeats the mark's
diagonal cut. All lettering is drawn as paths. No fonts, external images, or
runtime dependencies are required to display the SVG files.

## Assets

- `fraq-logo.svg`: primary horizontal logo, dark ink on transparency.
- `fraq-logo-white.svg`: horizontal logo for dark backgrounds.
- `fraq-symbol.svg`: standalone mark, dark ink on transparency.
- `fraq-symbol-white.svg`: standalone mark for dark backgrounds.
- `fraq-logo.png`: transparent horizontal export at 4x resolution.
- `fraq-symbol.png`: transparent 1024px mark.
- `fraq-avatar.png`: 1024px dark square with a white mark.
- `preview.png`: light, dark, and small-size presentation.

## Usage

Primary colors are ink `#171717` and white `#FFFFFF`. Keep the mark monochrome.
Do not close the diagonal gap, rotate the detached module, stretch the logo,
or add gradients and shadows. Keep clear space of at least one stem width
around the visible artwork: 20 units in the original 128-unit symbol.

Use the symbol at 16px or larger. Use the horizontal logo at 64px or larger;
prefer the standalone symbol when space is limited. The white variants must
be placed on a dark background.

## Design Basis

Source material: the repository README, package introduction, documentation
homepage, and existing neutral documentation theme. The design emphasizes
type safety, composability, and a unified context through a simple geometric
letterform. It intentionally uses no protocol-specific illustration.

Design brief: create a restrained monochrome Fraq identity for a TypeScript
chatbot framework; build an identifiable F from a stable body and a detached
plugin-like terminal; use one 45-degree cut, consistent weights, generous
negative space, and a custom geometric wordmark; verify dark backgrounds and
small sizes. Deliver editable, self-contained vector assets.

Created directly as SVG paths. No image-generation model or CLI was used.

The documentation site's shared `FraqLogo` component uses the same paths
with `currentColor` for light and dark themes and social images. Browser
icons use the standalone F; the SVG browser icon follows the system theme.
When changing the design, update both the SVG masters and that component.
