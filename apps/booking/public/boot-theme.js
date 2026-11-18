// Studio only: apply the saved theme before the first paint, so dark mode
// never flashes light while the app loads. Mirrors applyTheme in account-menu.js.
(function(){try{var p=location.pathname;if(p!=='/'&&p!=='/studio')return;var v=localStorage.getItem('scheduling-theme'),d=document.documentElement;d.dataset.theme=v==='dark'||v==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';d.dataset.accent='graphite';}catch(e){}})();
