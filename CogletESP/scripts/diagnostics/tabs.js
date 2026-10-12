export function setupTabs(root = document) {
  const tabs = [...root.querySelectorAll('[role="tab"]')];

  function select(tab) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      root.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
    }
    root.getElementById(tab.getAttribute("aria-controls")).dispatchEvent(new Event("tabshown"));
  }

  function selectWithTransition(tab) {
    if (typeof document !== "undefined" && typeof window !== "undefined" &&
      document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.startViewTransition(() => select(tab));
      return;
    }
    select(tab);
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => selectWithTransition(tab));
    tab.addEventListener("keydown", event => {
      let index = tabs.indexOf(tab);
      if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") index = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = tabs.length - 1;
      else return;
      event.preventDefault();
      selectWithTransition(tabs[index]);
      tabs[index].focus();
    });
  }
  select(tabs[0]);
}
