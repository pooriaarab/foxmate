// The target: the tab that foxmate works on. foxmate is a page of its own
// (a tab, or the sidebar), and it must never work on itself. So the target
// is the tab the user picked, else the active web tab of this window (the
// sidebar case), else the web tab the user used last (the full-page case:
// the tab they were on before they opened foxmate). Only http and https
// tabs count.
const $ = (id) => document.getElementById(id);
const isWeb = (tab) => /^https?:/.test(tab?.url ?? "");
let picked;
let pending;

/** The web tabs, the one used last first. */
async function webTabs() {
  return (await browser.tabs.query({})).filter(isWeb).toSorted((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
}

/** The tab that a goal runs on now, or undefined when no web tab is open. */
export async function targetTab() {
  const tabs = await webTabs();
  const chosen = tabs.find((t) => t.id === picked);
  if (chosen) return chosen;
  picked = undefined;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  return isWeb(active) ? active : tabs[0];
}

export const hostOf = (tab) => {
  try {
    return new URL(tab.url).hostname;
  } catch {
    return "";
  }
};

async function render() {
  const tab = await targetTab();
  const button = $("target");
  button.dataset.empty = String(!tab);
  $("target-name").textContent = tab ? hostOf(tab) : "No tab open";
  button.title = tab ? `${tab.title}\n${tab.url}` : "foxmate asks before it opens a site.";
  if ($("target-menu").matches(":popover-open")) await renderMenu(tab);
}

async function renderMenu(current) {
  const tabs = await webTabs();
  const items = tabs.slice(0, 12).map((tab) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(tab.id === current?.id));
    const title = document.createElement("span");
    title.className = "menu-item-title";
    title.textContent = tab.title || hostOf(tab);
    const host = document.createElement("span");
    host.className = "menu-item-host";
    host.textContent = hostOf(tab);
    b.append(title, host);
    b.addEventListener("click", () => {
      picked = tab.id;
      $("target-menu").hidePopover();
      void render();
    });
    li.append(b);
    return li;
  });
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "menu-empty";
    li.textContent = "No web page is open. foxmate asks before it opens a site.";
    items.push(li);
  }
  $("target-list").replaceChildren(...items);
}

/** Re-renders at most once a frame: tabs.onUpdated fires often while a page loads. */
const soon = () => {
  pending ??= requestAnimationFrame(() => {
    pending = undefined;
    void render();
  });
};

export const target = {
  init() {
    const button = $("target");
    const menu = $("target-menu");
    // The chip opens the menu with popovertarget, so a second click or Escape closes it.
    menu.addEventListener("beforetoggle", (event) => {
      if (event.newState !== "open") return;
      // The menu opens above the chip, inside the window. Its width is min(360px, 100vw - 16px).
      const r = button.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - Math.min(360, innerWidth - 16) - 8))}px`;
      menu.style.bottom = `${innerHeight - r.top + 8}px`;
    });
    menu.addEventListener("toggle", async (event) => {
      const open = event.newState === "open";
      button.setAttribute("aria-expanded", String(open));
      if (open) await renderMenu(await targetTab());
    });
    browser.tabs.onActivated.addListener(soon);
    browser.tabs.onRemoved.addListener(soon);
    browser.tabs.onUpdated.addListener((_id, change) => {
      if (change.url || change.title || change.status === "complete") soon();
    });
    void render();
  },
};
