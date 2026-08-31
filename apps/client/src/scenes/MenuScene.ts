import Phaser from 'phaser';
import { PROTOCOL_VERSION } from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { UI, cssColor } from '../art/palette';
import type { LocalConnection } from './connectionTypes';

/**
 * The main menu.
 *
 * Two ways in, and they meet in the same place (spec sections 9 and 10):
 *
 * - **Single player** asks the Electron shell to spawn a local GameServer and connects
 *   to the loopback port it reports. In a plain browser there is no shell, so the button
 *   explains that and offers the address field instead.
 * - **Join server** connects to a remote address.
 *
 * Either way the client ends up doing the same thing: connecting to an authoritative
 * server over the same protocol.
 */
import { t } from '../ui/strings';

export class MenuScene extends Phaser.Scene {
  static readonly KEY = 'Menu';

  private root!: HTMLDivElement;

  constructor() {
    super(MenuScene.KEY);
  }

  create(sceneData?: { error?: string }): void {
    const data = this.registry.get('gameData') as GameData;
    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.root.innerHTML = this.markup(data.version);
    document.body.append(this.root);
    this.injectStyles();
    this.wire();
    // A connect attempt that failed sends its reason back here, so the player finds out
    // on the screen where they can do something about it.
    if (sceneData?.error) this.status(sceneData.error, 'error');

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.root.remove());
  }

  private markup(dataVersion: string): string {
    const desktop = typeof window.survive !== 'undefined';
    return `
      <div class="menu-panel">
        <h1>${t('menu.title')}</h1>
        <p class="menu-sub">${t('menu.tagline')}</p>

        <section class="menu-block">
          <h2>${t('menu.singlePlayer')}</h2>
          ${
            desktop
              ? `<div class="menu-row">
                   <input id="sp-world" type="text" value="world01" maxlength="24"
                          aria-label="${t('menu.worldName')}" />
                   <button id="sp-start" class="primary">${t('menu.play')}</button>
                 </div>
                 <ul id="sp-worlds" class="menu-list"></ul>`
              : `<p class="menu-note">
                   ${t('menu.desktopOnly')}
                   <code>npm run start:server</code>
                 </p>`
          }
        </section>

        <section class="menu-block">
          <h2>${t('menu.joinServer')}</h2>
          <div class="menu-row">
            <input id="mp-url" type="text" value="http://127.0.0.1:27500"
                   aria-label="${t('menu.serverAddress')}" />
            <button id="mp-join">${t('menu.join')}</button>
          </div>
          <div class="menu-row">
            <input id="mp-name" type="text" value="Survivor" maxlength="24"
                   aria-label="${t('menu.playerName')}" />
            <input id="mp-password" type="password" placeholder="${t('menu.passwordPlaceholder')}"
                   aria-label="${t('menu.serverPassword')}" />
          </div>
          <div class="menu-row">
            <button id="mp-reset" class="danger">${t('menu.reset')}</button>
          </div>
        </section>

        <p id="menu-status" class="menu-status" role="status"></p>
        <footer class="menu-foot">${t('menu.versions', { protocol: PROTOCOL_VERSION, content: dataVersion })}</footer>
      </div>
    `;
  }

  private injectStyles(): void {
    if (document.getElementById('menu-styles')) return;
    const style = document.createElement('style');
    style.id = 'menu-styles';
    style.textContent = `
      .menu {
        position: fixed; inset: 0; display: grid; place-items: center;
        background: radial-gradient(circle at 50% 30%, #101718 0%, #07090a 70%);
        z-index: 5;
      }
      .menu-panel {
        width: min(520px, 90vw); padding: 28px 30px 20px;
        background: ${cssColor(UI.panel, 0.96)};
        border: 1px solid ${cssColor(UI.panelEdge)};
        border-radius: 10px;
      }
      .menu-panel h1 {
        margin: 0; font-size: 34px; letter-spacing: 0.3em; text-transform: uppercase;
      }
      .menu-sub { margin: 4px 0 22px; color: ${cssColor(UI.textMuted)}; font-size: 13px; }
      .menu-block { margin-bottom: 22px; }
      .menu-block h2 {
        margin: 0 0 8px; font-size: 11px; text-transform: uppercase;
        letter-spacing: 0.1em; color: ${cssColor(UI.textMuted)};
      }
      .menu-row { display: flex; gap: 8px; margin-bottom: 8px; }
      .menu-row input { flex: 1; min-width: 0; }
      .menu input {
        padding: 9px 10px; background: ${cssColor(UI.slot)};
        border: 1px solid ${cssColor(UI.slotEdge)}; border-radius: 5px;
        color: ${cssColor(UI.text)}; font: inherit; font-size: 13px;
      }
      .menu button {
        padding: 9px 18px; border-radius: 5px; font: inherit; font-weight: 600;
        cursor: pointer; background: ${cssColor(UI.slot)};
        border: 1px solid ${cssColor(UI.slotEdge)}; color: ${cssColor(UI.text)};
      }
      .menu button.primary {
        background: ${cssColor(UI.accent)}; border-color: ${cssColor(UI.accent)};
        color: #0d1a0f;
      }
      /* Quiet until it is armed: a destructive button that shouts before it has been
         asked twice is just noise beside the button people actually came here to press. */
      .menu button.danger { color: ${cssColor(UI.danger)}; }
      .menu button.danger.armed {
        background: ${cssColor(UI.danger)}; border-color: ${cssColor(UI.danger)}; color: #1a0d0d;
      }
      .menu button:disabled { opacity: 0.5; cursor: default; }
      .menu-note { margin: 0; font-size: 12px; color: ${cssColor(UI.textMuted)}; line-height: 1.6; }
      .menu-note code {
        background: ${cssColor(UI.slot)}; padding: 1px 5px; border-radius: 3px;
      }
      .menu-list { list-style: none; margin: 6px 0 0; padding: 0; font-size: 12px; }
      .menu-list li {
        display: flex; justify-content: space-between; padding: 4px 6px;
        color: ${cssColor(UI.textMuted)}; border-radius: 4px; cursor: pointer;
      }
      .menu-list li:hover { background: ${cssColor(UI.slotHover)}; color: ${cssColor(UI.text)}; }
      .menu-status { min-height: 18px; margin: 0 0 6px; font-size: 12px; color: ${cssColor(UI.warn)}; }
      .menu-foot { margin: 0; font-size: 11px; color: #52605f; text-align: right; }
    `;
    document.head.append(style);
  }

  private status(message: string, tone: 'info' | 'error' = 'info'): void {
    const node = this.root.querySelector<HTMLElement>('#menu-status');
    if (!node) return;
    node.textContent = message;
    node.style.color = cssColor(tone === 'error' ? UI.danger : UI.warn);
  }

  private wire(): void {
    const bridge = window.survive;

    if (bridge) {
      void this.refreshWorlds(bridge);
      this.root.querySelector('#sp-start')?.addEventListener('click', () => {
        const world =
          this.root.querySelector<HTMLInputElement>('#sp-world')?.value.trim() || 'world01';
        void this.startSinglePlayer(world);
      });
    }

    this.root.querySelector('#mp-join')?.addEventListener('click', () => {
      const url = this.root.querySelector<HTMLInputElement>('#mp-url')?.value.trim() ?? '';
      const name =
        this.root.querySelector<HTMLInputElement>('#mp-name')?.value.trim() || 'Survivor';
      const password = this.root.querySelector<HTMLInputElement>('#mp-password')?.value ?? '';
      if (!url) {
        this.status(t('menu.needAddress'), 'error');
        return;
      }
      this.launch({ url, room: 'survive', token: '', world: '', port: 0 }, name, password);
    });

    this.root.querySelector('#mp-reset')?.addEventListener('click', () => {
      void this.resetWorld();
    });
    // Touching anything else takes the reset off its hair trigger, so an armed button
    // cannot sit there waiting for an unrelated click a minute later.
    this.root.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement | null)?.id !== 'mp-reset') this.disarmReset();
    });

    // Enter in any field is "go".
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const target = event.target as HTMLElement | null;
      if (target?.id === 'sp-world')
        this.root.querySelector<HTMLButtonElement>('#sp-start')?.click();
      else this.root.querySelector<HTMLButtonElement>('#mp-join')?.click();
    });
  }

  /**
   * Delete the world on the server in the address field, in two clicks.
   *
   * Two clicks rather than a modal because this menu is plain DOM with no dialog of its
   * own, and rather than a typed confirmation because the thing being destroyed is a save
   * the player can recreate in one click - the cost of a mistake is an evening, not a
   * career. The first click says what will happen and the second does it; anything else on
   * the screen disarms it, so a stray double-click on the wrong button cannot wipe a world.
   *
   * The server decides whether this is allowed at all: only a request from the machine
   * running it is accepted. The refusal is reported as what it is rather than as a generic
   * failure, because "do it from the other computer" is an instruction the player can act
   * on and "something went wrong" is not.
   */
  private async resetWorld(): Promise<void> {
    const button = this.root.querySelector<HTMLButtonElement>('#mp-reset');
    const url = this.root.querySelector<HTMLInputElement>('#mp-url')?.value.trim() ?? '';
    if (!button) return;
    if (!url) {
      this.status(t('menu.needAddress'), 'error');
      return;
    }

    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      this.status(t('menu.resetArmed'), 'error');
      return;
    }

    button.classList.remove('armed');
    button.disabled = true;
    this.status(t('menu.resetBusy'));
    try {
      const response = await fetch(new URL('/admin/reset', url), {
        method: 'POST',
        // Not a secret - the server ignores the value. Setting a header at all is what
        // makes this a request a page on the internet cannot forge: it forces a CORS
        // preflight, and the server answers that only for a page served from this machine.
        headers: { 'x-survive-admin': 'reset' },
      });
      if (response.ok) this.status(t('menu.resetDone'));
      // 404 as well as 501: a server too old to carry this route has no reset either, and
      // "this server does not allow it" is the true and useful thing to say about both.
      else if (response.status === 501 || response.status === 404) {
        this.status(t('menu.resetUnsupported'), 'error');
      } else if (response.status === 403) {
        this.status(t('menu.resetNotLocal'), 'error');
      } else this.status(t('menu.resetFailed'), 'error');
    } catch {
      // A bad address, a server that is not running, or a browser that refused the
      // cross-origin request - none of which the player can tell apart, and all of which
      // mean the same thing to them.
      this.status(t('menu.resetUnreachable'), 'error');
    } finally {
      button.disabled = false;
    }
  }

  /** Take the reset button off its hair trigger. */
  private disarmReset(): void {
    const button = this.root.querySelector<HTMLButtonElement>('#mp-reset');
    if (button?.classList.contains('armed')) {
      button.classList.remove('armed');
      this.status('');
    }
  }

  private async refreshWorlds(bridge: NonNullable<Window['survive']>): Promise<void> {
    const list = this.root.querySelector<HTMLUListElement>('#sp-worlds');
    if (!list) return;
    try {
      const worlds = await bridge.listWorlds();
      list.replaceChildren(
        ...worlds.map((world) => {
          const item = document.createElement('li');
          item.innerHTML = `<span>${world.name}</span><span>day ${world.day}</span>`;
          item.addEventListener('click', () => {
            const field = this.root.querySelector<HTMLInputElement>('#sp-world');
            if (field) field.value = world.name;
          });
          return item;
        }),
      );
    } catch {
      // A missing saves folder is normal on a first run.
    }
  }

  private async startSinglePlayer(world: string): Promise<void> {
    const bridge = window.survive;
    if (!bridge) return;
    const button = this.root.querySelector<HTMLButtonElement>('#sp-start');
    if (button) button.disabled = true;
    this.status('starting local server…');
    try {
      const connection = await bridge.startSinglePlayer({ world });
      this.launch(connection, 'Survivor', '');
    } catch (error) {
      this.status(`Could not start the local server: ${String(error)}`, 'error');
      if (button) button.disabled = false;
    }
  }

  private launch(connection: LocalConnection, name: string, password: string): void {
    this.status('connecting…');
    this.scene.start('Game', { connection, name, password });
  }
}
