import type { EntityId } from '@survive/protocol';
import type { SimulationState } from './state';

/** Short prefixes keep ids readable in logs and save files. */
export const IdPrefix = {
  Zombie: 'z',
  Animal: 'a',
  Item: 'i',
  Projectile: 'r',
  Structure: 's',
  Node: 'n',
  Horde: 'h',
  CraftJob: 'c',
} as const;

/** Allocates unique, stable, human-readable entity ids from the world counter. */
export class IdAllocator {
  constructor(private readonly state: SimulationState) {}

  next(prefix: string): EntityId {
    const id = this.state.nextId++;
    return `${prefix}${id}`;
  }

  zombie(): EntityId {
    return this.next(IdPrefix.Zombie);
  }
  animal(): EntityId {
    return this.next(IdPrefix.Animal);
  }
  item(): EntityId {
    return this.next(IdPrefix.Item);
  }
  projectile(): EntityId {
    return this.next(IdPrefix.Projectile);
  }
  structure(): EntityId {
    return this.next(IdPrefix.Structure);
  }
  node(): EntityId {
    return this.next(IdPrefix.Node);
  }
  horde(): EntityId {
    return this.next(IdPrefix.Horde);
  }
  craftJob(): EntityId {
    return this.next(IdPrefix.CraftJob);
  }
}
