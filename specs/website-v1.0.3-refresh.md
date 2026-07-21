# Pixel Crew Website v1.0.3 Refresh

## Status

- Version: 1.0
- Target release: Pixel Crew v1.0.3
- Locales: Traditional Chinese and English
- Decision: approved for implementation from the user's request on 2026-07-21

## Problem

The homepage explains the original Pixel Crew workflow well, but the v1.0.3 capabilities only appear deep in the release history. Visitors cannot quickly see that Pixel Crew now covers MCP management, local backup and restore, complete focus-mode controls, usage cost visibility, long-session ergonomics, and stronger local safeguards.

The updated custom-avatar screenshot also needs accurate dimensions and copy in every place where it appears.

## Goals

1. Make v1.0.3 visible immediately after the product hero.
2. Explain the release as a coherent upgrade to daily operations, not a changelog dump.
3. Use real product captures as supporting evidence.
4. Keep the existing scene-based product tour and installation content.
5. Keep Traditional Chinese and English information architecture aligned.
6. Preserve the static, dependency-free site and current SEO contract.

## Information architecture

1. Navigation
2. Hero and primary download action
3. v1.0.3 launch showcase
4. Core product tour
5. Local-first security model
6. Compact release history
7. Installation options
8. FAQ and legal footer

## v1.0.3 showcase

The launch showcase must contain:

- A release label, date, concise positioning statement, and release-notes link.
- Six capability cards: MCP management, backup and restore, focus-mode controls, cost and quota visibility, keyboard and long-session UX, and security/reliability.
- A three-image evidence strip using the usage panel, final-report view, and updated custom-avatar workshop capture.
- Captions that describe what is visible without claiming that every screenshot is exclusive to v1.0.3.

The detailed six-card list must live only in this showcase. The release-history entry for v1.0.3 remains a short summary and link.

## Visual system

- Preserve the existing dark pixel-office interface language.
- Use cyan for interaction and navigation, green for local/safe states, and gold for the release marker.
- Separate the launch showcase from the long product tour with a raised panel and subtle grid treatment.
- Use asymmetrical card spans on wide screens and a single readable column on small screens.
- Keep screenshots in bordered application frames with descriptive captions.
- Avoid decorative imagery that does not explain the product.

## Responsive behavior

- At desktop width, the release introduction and metadata share a row; capability cards form a 12-column bento grid.
- Below 820px, capability cards become two equal columns and the evidence strip becomes a single column.
- Below 640px, all cards become a single column and primary actions remain easy to tap.
- No horizontal page overflow is allowed; screenshots retain their intrinsic aspect ratios.

## Accessibility and content requirements

- Keep one `h1` per localized page and maintain logical heading order.
- Navigation links must target existing section IDs.
- Every screenshot must include accurate `alt`, `width`, and `height` attributes.
- Text and interactive controls must retain visible keyboard focus.
- Motion remains disabled when `prefers-reduced-motion` is enabled.
- Updated custom-avatar copy must describe the blue animated pixel character shown in the capture.

## Acceptance criteria

- Both locales expose a v1.0.3 navigation target and launch showcase above the general feature tour.
- Both locales present the same six v1.0.3 capabilities and the same three supporting images.
- The release-history entry does not repeat the full six-card list.
- The custom-avatar image uses its real 1606 × 1416 dimensions and updated alternative text.
- Existing canonical, hreflang, JSON-LD, sitemap, manifest, and local asset checks pass.
- HTML has no duplicate IDs, broken fragment links, missing local assets, or whitespace errors.
