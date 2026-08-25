/**
 * Input consumption and player motion.
 *
 * Two systems, split because they run at different points in the tick and answer to
 * different owners: {@link createInputSystem} at {@link SystemOrder.Input} decides what
 * each player asked for this tick, {@link createMovementSystem} at
 * {@link SystemOrder.Movement} turns that into position. Everything between them - and
 * combat after them - reads the one frame the input system published on `ctx.inputs`.
 *
 * WIRING - READ THIS
 * ------------------
 * The pending-input buffer lives on the {@link import('../../simulation').Simulation},
 * not on `SimContext`: it is transient network state and deliberately not part of the
 * world. So {@link createInputSystem} has to be pointed at it, in one of two ways:
 *
 * ```ts
 * // Either hand the getter over at construction...
 * const sim = new Simulation({ config, data, world, systems: [createInputSystem(host), ...] });
 * // ...or build the systems with no arguments and bind once the host exists. This is
 * // the form `createDefaultSystems()` needs, because it takes no arguments.
 * bindInputSource(sim);
 * ```
 *
 * An unbound input system is not an error - it logs once and every player coasts - but
 * it does mean no player ever moves, so any host that wires `createInputSystem()` into
 * its system list must call {@link bindInputSource} exactly once after construction.
 */
export {
  AIM_EPSILON,
  KNOWN_BUTTONS,
  applyAim,
  bindInputSource,
  coastingFrame,
  createInputSystem,
  resolveTakeInput,
  sanitizeInputFrame,
  unbindInputSource,
  type InputSource,
  type InputSourceHost,
  type TakeInput,
} from './input';
export {
  FOOTSTEP_LOUDNESS,
  FOOTSTEP_STRIDE_PX,
  clampIntoWorld,
  createMovementSystem,
  footstepRadius,
} from './movement';
