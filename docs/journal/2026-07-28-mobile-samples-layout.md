# Mobile samples layout and navigation

The samples page looked wider than an iPhone viewport because the single-column
mobile grid used a bare `1fr` track. Long syntax blocks contributed their
min-content width, so each card expanded to roughly 780px even though the grid
itself was only 358px wide. Explicitly using a zero-minimum grid track and
allowing cards to shrink keeps the code block scrollable inside the card.

The same mobile screenshot showed the header links wrapping into a tall,
two-row header. The final implementation keeps a normal navigation element in
the document at every viewport size and uses a button-controlled hamburger on
narrow screens. This preserves the expanded desktop links while allowing the
mobile menu and icon to animate from explicit `aria-expanded` state.

The first investigation branch focused only on `.syntax-block { overflow: auto
}`. That did not solve the problem because the overflow container itself was
already inheriting the oversized card width; measuring the grid track and card
rectangles identified the intrinsic-size constraint instead.

An intermediate navigation implementation used a closed `details` element.
Computed CSS still reported the nested desktop navigation as `display: flex`,
but the browser did not render descendants of the closed disclosure widget.
This made a CSS-only assertion misleading. Keeping the navigation outside a
disclosure element and validating its actual browser rectangle caught and
removed that failure mode.
