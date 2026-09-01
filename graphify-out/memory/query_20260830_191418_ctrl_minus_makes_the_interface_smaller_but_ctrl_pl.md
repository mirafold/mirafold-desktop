---
type: "query"
date: "2026-08-30T19:14:18.088023+00:00"
question: "Ctrl-minus makes the interface smaller but Ctrl-plus does not make it bigger; diagnose and fix"
contributor: "graphify"
outcome: "useful"
source_nodes: ["interfaceScaleShortcut()", "createInterfaceScaleController()", "createWindow()", "buildMenu()"]
---

# Q: Ctrl-minus makes the interface smaller but Ctrl-plus does not make it bigger; diagnose and fix

## Answer

Expanded from the original query via graph vocabulary: before, controller, interface, key, main, menu, scale, shortcut, window. The graph located interfaceScaleShortcut at src/interface-scale.js line 36, createInterfaceScaleController at line 62, createWindow at src/main.js line 111, and buildMenu at line 508. Git history and isolated Electron probes then proved that released v0.3.3 generic zoom roles leave Ctrl-plus at scale 1 while Ctrl-minus changes scale to 0.9128709291752769; the unreleased next handler changes Ctrl-plus to 1.1 and Ctrl-minus back to 1.0. No new source edit is justified; the existing next fix must be released.

## Outcome

- Signal: useful

## Source Nodes

- interfaceScaleShortcut()
- createInterfaceScaleController()
- createWindow()
- buildMenu()