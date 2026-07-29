# Monaco overflow widgets in the full workbench

## Symptom

The completion list in the large `/embed` workbench was clipped at the top when the cursor was near the first visible editor lines. The same problem was less obvious in `/playground` because its taller editor often allowed Monaco to place the list below the cursor.

## Investigation

The workbench editor host uses `overflow: hidden`. Monaco's completion widget was positioned above the cursor as an absolutely positioned child of the editor's `overflowingContentWidgets` container, so the part outside the editor host was clipped. Changing only the surrounding page layout would leave the behavior dependent on the host's overflow and height.

## Fix

Enable Monaco's `fixedOverflowWidgets` option for the shared embed editor factory. Monaco then positions completion widgets as fixed overflow widgets and can choose a visible placement using the viewport rather than the editor host's clipping boundary. The browser reproduction confirms that the popup remains complete and includes `fetch` in the full workbench.

## Regression risk

All embed variants use the shared editor factory, so the option applies consistently to simple, workspace, and full-workbench editors. The option affects Monaco widget placement only; editor content and workbench layout remain unchanged.
