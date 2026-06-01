
known issues/needed improvements:
- [ ] text is not centred on nodes
- [ ] labels of edges partially hidden by a container can be placed over the container, thus seeming unrelated to the edge they belong to
- [ ] +/- zooms in/out instead of increasing/decreasing LOD globally
- [ ] renaming is not very user-friendly:
  - [ ] renaming edges within a dashed bounding box renames the parent element instead
  - [ ] renaming box needs to be restyled:
    - [ ] rounded corners & dashed border
    - [ ] animated appear/disappear
    - [ ] larger for edge renaming, smaller for node renaming
    - [ ] text field text size is inconsistent with node text size, usually larger and getting clipped
    - [ ] or instead!: highlight the node/edge being renamed, and have the text field appear in a fixed location (maybe bottom left of screen?)
- [ ] keyboard shortcuts dont work at all (probably keys are not captured properly?)
- [ ] clicking on project root dir "~" does not work

necessary additions:
- [ ] somewhere visible whether changes have been saved to the original file
- [ ] undo history, ctrl/cmd+z and +r
- [ ] diff-like config changes saved to a separate file (before overwriting original), so changes can be reverted even after saving or shutting down the backend
- [ ] re-parse config file without restarting the backend

low priority:
- [ ] change flashing border of leaf nodes (on scroll) to turn red instead
- [ ] restyle top bar
- [ ] change theme
- [ ] split app.js into smaller modules