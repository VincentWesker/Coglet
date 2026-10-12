# Coglet diagnostics visual system

The diagnostics UI is a control cockpit for a small physical robot: a persistent navigation and connection strip frames focused workspaces for Logging, Motion, and Firmware. Keep the hardware's state and the next safe action easy to scan. This is an operating tool, not a marketing dashboard.

Use cool light gray `#edf0ed`, white `#ffffff`, charcoal `#202622`, and Coglet yellow `#e6ad00` as the focused action and selection accent. Yellow controls use dark ink for readable text. Errors and warnings retain distinct, high-contrast written states; never imply hardware health from missing log evidence. Interface text uses the desktop system sans; captured logs, measurements, and source evidence use monospace.

Logging gives the transcript most of the desktop width and keeps the diagnostic evidence beside it. Motion puts the servo map and safe, explicit controls in one workbench. Firmware remains a deliberate preparation-and-upload flow. Narrow screens stack workspaces without hiding controls. Tabs preserve their existing state and use a supported shared-workspace transition, with an immediate fallback and reduced-motion behavior. Keep visible labels, keyboard focus, disabled states, and explicit errors.
