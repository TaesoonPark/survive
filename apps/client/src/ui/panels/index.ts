import type { Panel } from '../panel';
import { createBuildPanel } from './build';
import { createBodyPanel, createContainerPanel } from './containerBody';
import { createCraftingPanel } from './crafting';
import { createInventoryPanel } from './inventory';
import { createMapPanel, createSkillsPanel } from './mapSkills';
import { createChatPanel, createDeathPanel, createDebugPanel, createPausePanel } from './session';

/**
 * Every panel, in the order they stack.
 *
 * Panels are opened by id (see `UiScene.onUiAction` for the key bindings), so nothing
 * outside this list needs to know which panels exist. The order matters only for
 * z-stacking when several are open at once, which is why the modal ones - death and
 * pause - come last: nothing should be able to sit on top of them.
 *
 * | id          | key   | captures input |
 * |-------------|-------|----------------|
 * | `build`     | B     | no  (you place in the world while it is open) |
 * | `inventory`  | I/Tab | yes |
 * | `container` | (auto)| yes (opened by the server when you open a chest) |
 * | `crafting`  | Q     | yes |
 * | `body`      | H     | yes |
 * | `skills`    | -     | yes (opened from the body screen) |
 * | `map`       | M     | yes |
 * | `chat`      | Y     | yes |
 * | `debug`     | F3    | no  |
 * | `pause`     | Esc   | yes |
 * | `death`     | (auto)| yes (opened by the server when you die) |
 */
export function createPanels(): Panel[] {
  return [
    createBuildPanel(),
    createInventoryPanel(),
    createContainerPanel(),
    createCraftingPanel(),
    createBodyPanel(),
    createSkillsPanel(),
    createMapPanel(),
    createChatPanel(),
    createDebugPanel(),
    createPausePanel(),
    createDeathPanel(),
  ];
}

export { createBuildPanel } from './build';
export { createBodyPanel, createContainerPanel } from './containerBody';
export { createCraftingPanel } from './crafting';
export { createInventoryPanel } from './inventory';
export { createMapPanel, createSkillsPanel } from './mapSkills';
export { createChatPanel, createDeathPanel, createDebugPanel, createPausePanel } from './session';
