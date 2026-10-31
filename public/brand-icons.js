const paths={
 marketing:'M3 10l13-6v16L3 14z M6 15l2 6h4l-2-5 M20 7l2-2 M20 17l2 2 M20 12h3',
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
 instagram:'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4 M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M17 6h.01'
};
export function brandIcon(name,size=22){return '<svg class="brand-icon" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(paths[name]||paths.settings)+'"/></svg>';}
