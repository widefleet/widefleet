# Control-plane design

Use this guide to make management screens coherent, easy to scan and focused on the user's task. Before editing, identify who uses the screen, what they need to decide or do, and which existing flow is closest. Read the [interaction constraints](control-plane-experience.md) when authentication, permissions or background work are involved.

## Establish hierarchy

Give the current task the strongest visual emphasis. Navigation and supporting information should remain readable while receding from the work. A request for another label, card or action is a reason to examine the whole flow: identify the missing information before choosing where to put it.

| Decision                           | Guideline                                                                                                                                | Reason                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Product, organization and location | Give each a clear role and place in the shell. Repeat context only when users need it to make a decision safely.                         | Repeated branding adds noise; organization context can prevent acting in the wrong workspace.           |
| Empty header space                 | Leave it empty unless a relevant action or useful state belongs there.                                                                   | Visual balance does not require another label or control.                                               |
| Page title and subtitle            | Name the task or resource directly. Add a subtitle only when it explains scope, a constraint or the next step.                           | A heading such as “Apps” can stand alone; a general productivity slogan does not help manage apps.      |
| Icons and color                    | Use recognizable resource icons when available and a muted fallback otherwise. Reserve stronger color for meaningful status or emphasis. | Icons should help distinguish items; identical colored tiles can overwhelm the information beside them. |
| Lists and spacing                  | Keep repeated rows compact and aligned, preserving readable labels, focus rings and usable touch targets.                                | Users need to compare names and states without losing interaction comfort.                              |
| Borders and containers             | Group related content with alignment and spacing first. Add a boundary when it clarifies ownership or interaction.                       | Nested cards and separators should explain structure rather than decorate it.                           |
| Actions                            | Give the next likely action clear emphasis. Place secondary actions near their subject or in an appropriate menu.                        | Competing primary buttons make the next step harder to find.                                            |

## Reuse the visual system

Start with the installed shadcn-svelte components, existing shared patterns and semantic Tailwind tokens. Keep exact colors, spacing and component variants in code instead of maintaining another token inventory here.

Inspect how [page headings](../apps/control-plane/src/lib/components/PageHeading.svelte) make descriptions optional and how [status labels](../apps/control-plane/src/lib/components/AppStatus.svelte) pair color with text. Follow the relevant pattern across neighboring screens; change a shared component when the intended improvement applies to all its callers. Existing screens can contain inconsistencies, so check them against the task and these guidelines before copying them.

Keep essential context available at narrow widths. Preserve image proportions and reserve their layout space while loading or falling back. Interactive controls need clear hover, focus, pending and disabled states. Motion should explain a transition or acknowledge an action, stay unobtrusive during repeated use, and respect reduced-motion preferences.

## Choose an editing surface

Prefer inline editing for small, independent, reversible changes when the surrounding context helps users, such as changing an app's display name or a short description. Make editability apparent on touch devices and with keyboard focus as well as on hover.

Group dependent fields into a form with a shared save action. Use dialogs for short, self-contained tasks or consequential confirmations. Use a dedicated page for complex workflows or decisions that require consulting other information.

Make save and cancel behavior explicit with visible controls and appropriate keyboard support. Keep validation errors beside the field and preserve the draft when saving fails. Avoid implicitly saving or discarding unfinished text when focus leaves the editor. Changes to permissions or running services need a clear commit action that communicates their consequences.

## Review the rendered result

Use [local fixtures and verification](development.md#local-verification). Before opening or updating a UI PR:

1. State the intended user-visible improvement so the result has a concrete review criterion.
2. Inspect the affected flow at desktop and narrow mobile widths, in light and dark themes. Compare before and after for changes to layout or hierarchy.
3. Check for redundant labels, competing emphasis, unnecessary containers, awkward gaps, clipping and layout shifts. Verify long names and realistic list density where relevant.
4. Exercise the changed interactions with pointer and keyboard. Check relevant empty, loading, failure and permission states, including image fallbacks when applicable.
5. Include labeled before/after screenshots in the PR description for every visible UI change. Capture the original and updated application with the same synthetic data, viewport, theme and interaction state so reviewers can compare them directly. Cover the affected desktop and mobile views and light and dark themes; refresh the after images when subsequent changes alter the result. Documentation-only and backend-only changes do not need screenshots.
6. Record the views and states checked and any verification gaps in the PR. If a screenshot cannot be captured, explain the blocker explicitly instead of presenting a mockup as verification. Passing functional tests alone does not establish visual quality.

## References

- [Linear's interface refresh](https://linear.app/now/behind-the-latest-design-refresh): restrained navigation, meaningful emphasis and quieter structure.
- [Linear's product reasoning skill](https://gist.github.com/ksaa/5644e3225be8af5eef4fa1bed0e7e88a): understand the underlying need and consider tradeoffs before committing to a solution.
- [Emil Kowalski's Agents with Taste](https://emilkowal.ski/ui/agents-with-taste): make design judgments explicit through concrete rules, reasons and examples.
- [Atlassian's inline-edit guidelines](https://atlassian.design/components/inline-edit/usage) and [Carbon's dialog guidelines](https://www.carbondesignsystem.com/building-blocks/core/patterns/dialogs): preserve context for frequent edits and use focused dialogs deliberately.

These references inform the guidelines above; apply them to Widefleet's workflows and existing visual system.
