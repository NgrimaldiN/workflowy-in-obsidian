#!/bin/zsh
# Reset the "Flow-Demo" vault to its starting state before a capture run.
set -e
D=$1
cat > $D/Outline.md <<'MD'
- Work
	- Ship Flow Outliner v0.1 #launch
		- Write the README
		- Record a demo video
		- Publish on GitHub
	- Weekly review every Friday
- Personal
	- Trip to Japan #travel
		- Book flights
		- Tokyo
			- Shibuya at night
			- Tsukiji outer market
		- Kyoto
			- Ryokan near Gion
			- Fushimi Inari at sunrise
	- Reading list
		- The Pragmatic Programmer
		- Thinking, Fast and Slow
- Ideas #inbox
MD
O=(obsidian vault=Flow-Demo)
$O eval code="(async()=>{app.workspace.getLeavesOfType('flow-outliner').forEach(l=>l.detach());const p=app.plugins.plugins['flow-outliner'];p.states={};await p.saveData({settings:p.settings,states:{}});return 1})()" >/dev/null
sleep 1
$O plugin:reload id=flow-outliner >/dev/null
sleep 1
$O eval code="(async()=>{const r=require('@electron/remote');r.getCurrentWebContents().setBackgroundThrottling(false);r.getCurrentWindow().setContentSize(1440,810);await app.plugins.plugins['flow-outliner'].openHome();const v=app.workspace.activeLeaf.view;v.zoomTo(v.doc.root,'out');v.expandAll(true);app.workspace.rightSplit.collapse();app.workspace.leftSplit.expand();app.workspace.leftSplit.setSize(250);if(!document.getElementById('demo-css')){const s=document.createElement('style');s.id='demo-css';s.textContent='.flow-editable{caret-color:transparent!important}.status-bar{display:none!important}';document.head.appendChild(s)}document.activeElement&&document.activeElement.blur();return 'reset'})()"
