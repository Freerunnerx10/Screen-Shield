# Window List Sorting Plan

## Steps
- [ ] Remove unused state `prioritizeHidden` and its setter from WindowList.jsx
- [ ] Remove unused `toggleLabel` variable from WindowList.jsx
- [ ] Modify WindowList.jsx to split groups into two categories:
      - Group 1: Groups with at least one hidden window (win.hidden === true)
      - Group 2: Groups with no hidden windows (all win.hidden === false)
- [ ] Sort Group 1 alphabetically by appName (A-Z)
- [ ] Sort Group 2 alphabetically by appName (A-Z)
- [ ] Render Group 1 followed by Group 2 in the WindowList component
- [ ] Verify that the eye icon logic in AppHeader remains unchanged (still based on group's window hidden states)
- [ ] Ensure no toggles, filters, or checkboxes are introduced
- [ ] Confirm persistence behavior: apps remain in list when minimized/trayed and while hidden
- [ ] Confirm removal condition: app only removed when all windows unhidden AND process closed