const paths={
 marketing:'M3 10l12-6v16L3 14z M6 15l2 6h4l-2-5 M19 7l2-2 M19 17l2 2 M19 12h3',
 dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 communications:'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5',
 assistant:'M12 3v3 M9 3h6 M5 8h14v12H5z M9 12v2 M15 12v2 M9 17h6 M2 11v5 M22 11v5',
 contacts:'M16 21v-3a4 4 0 0 0-8 0v3 M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M20 21v-3a4 4 0 0 0-3-4',
 tasks:'M8 4H5v17h14V4h-3 M8 2h8v5H8z M8 13l2 2 5-5',
 registrations:'M6 2h9l4 4v16H6z M14 2v6h5 M9 12h7 M9 16h7',
 hub:'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
 finance:'M3 5h18v15H3z M3 9h18 M15 15h3 M6 15h3',
 services:'M2 9l10-6 10 6-10 6z M6 12v6c4 3 8 3 12 0v-6 M22 9v9',
 plane:'M2 13l7-2 4-8 3 1-2 7 6 2 2 3-9-1-4 6-2-1 2-6-6 1z',
 document:'M5 2h10l4 4v16H5z M14 2v6h5 M8 12h8 M8 16h8',
 transfer:'M3 7h15l-4-4 M21 17H6l4 4 M18 7l-4 4 M6 17l4-4',
 training:'M3 4h18v13H3z M8 21l4-4 4 4 M8 8h8 M8 12h5',
 settings:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
 whatsapp:'M20 11a8 8 0 0 1-12 7l-5 2 2-5A8 8 0 1 1 20 11 M9 7c0 4 2 6 6 7',
 facebook:'M15 3h-3a4 4 0 0 0-4 4v14 M5 10h11 M12 7h4',
 tiktok:'M14 3v12a5 5 0 1 1-4-5 M14 3c1 4 4 5 7 5v4c-3 0-5-1-7-3',
 youtube:'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2 M10 9l6 3-6 3z',
 instagram:'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4 M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M17 6h.01',
 leads:'M4 4h4v16H4z M10 8h4v12h-4z M16 12h4v8h-4z M3 22h18',
 tickets:'M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4z M9 5v3 M9 11v2 M9 16v3',
 quotes:'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h2 M14 15h1 M9 18h6',
 studio:'M12 3l9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
 automations:'M4 3h6v6H4z M14 15h6v6h-6z M7 9v9h7 M10 6h7v9',
 users:'M8 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6 M16 4a3 3 0 0 1 0 6 M2 20v-4a5 5 0 0 1 10 0v4 M15 13a5 5 0 0 1 6 5v2',
 integrations:'M8 3v5 M16 3v5 M5 8h14v3a7 7 0 0 1-7 7v4 M5 8v3a7 7 0 0 0 7 7',
 audit:'M7 3h10v3H7z M7 5H4v17h16V5h-3 M8 11h8 M8 15h8 M8 19h5',
 security:'M12 2l8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5z M8 12l3 3 5-6',
 operations:'M3 12h4l3-7 4 14 3-7h4 M3 3h18v18H3z',
 lab:'M9 3h6 M10 3v7L4 20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1l-6-10V3 M8 15h8',
 website:'M3 4h18v16H3z M3 9h18 M6 6h.1 M9 6h.1 M8 13h8 M8 16h5',
 add:'M12 4v16 M4 12h16',
 close:'M6 6l12 12 M18 6L6 18',
 check:'M5 12l4 4L19 6',
 circle:'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
 sun:'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
 logout:'M10 3H4v18h6 M13 8l5 4-5 4 M8 12h13'
};
const aliases={inbox:'communications',social:'communications',templates:'document'};
export function brandIcon(name,size=22){
 const key=Object.hasOwn(paths,name)?name:Object.hasOwn(aliases,name)?aliases[name]:'document';
 const dimension=Number.isFinite(Number(size))?Math.min(64,Math.max(12,Math.round(Number(size)))):22;
 return '<svg class="brand-icon" width="'+dimension+'" height="'+dimension+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="'+paths[key]+'"/></svg>';
}
