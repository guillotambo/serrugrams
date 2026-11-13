import type { ReactNode } from "react";

const I = ({ children, size = 16 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Icon = {
  chevron: () => <I size={14}><path d="m9 6 6 6-6 6" /></I>,
  back: () => <I><path d="M19 12H5" /><path d="m11 6-6 6 6 6" /></I>,
  forward: () => <I><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></I>,
  file: () => <I size={15}><rect x="3" y="4" width="8" height="6" rx="1.5" /><rect x="13" y="14" width="8" height="6" rx="1.5" /><path d="M7 10v5a2 2 0 0 0 2 2h4" /></I>,
  folder: () => <I size={15}><path d="M3 7a2 2 0 0 1 2-2h4l2 2.500h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></I>,
  plus: () => <I><path d="M12 5v14M5 12h14" /></I>,
  folderPlus: () => <I><path d="M3 7a2 2 0 0 1 2-2h4l2 2.500h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M12 11v5M9.500 13.500h5" /></I>,
  more: () => <I><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></I>,
  link: () => <I><path d="M10 14a4 4 0 0 0 5.660 0l3-3a4 4 0 0 0-5.660-5.660l-1 1" /><path d="M14 10a4 4 0 0 0-5.660 0l-3 3a4 4 0 0 0 5.660 5.660l1-1" /></I>,
  comment: () => <I><path d="M20 11.500a7.500 7.500 0 0 1-11.200 6.530L4 19l1.070-4.300A7.500 7.500 0 1 1 20 11.500Z" /></I>,
  export: () => <I><path d="M12 15V4" /><path d="m7.500 8.500 4.500-4.500 4.500 4.500" /><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></I>,
  search: () => <I><circle cx="11" cy="11" r="6.500" /><path d="m20 20-4.200-4.200" /></I>,
  sidebar: () => <I><rect x="3" y="4.500" width="18" height="15" rx="2.500" /><path d="M9 4.500v15" /></I>,
  sun: () => <I><circle cx="12" cy="12" r="4" /><path d="M12 2.500v2M12 19.500v2M2.500 12h2M19.500 12h2M5.300 5.300l1.400 1.400M17.300 17.300l1.400 1.400M5.300 18.700l1.400-1.400M17.300 6.700l1.400-1.400" /></I>,
  moon: () => <I><path d="M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500Z" /></I>,
  check: () => <I><path d="m5 12.500 4.500 4.500L19 7.500" /></I>,
  close: () => <I><path d="M6 6l12 12M18 6 6 18" /></I>,
  trash: () => <I><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4.500h6V7" /></I>,
  tag: () => <I><path d="M3.500 12.200V5.500a2 2 0 0 1 2-2h6.700a2 2 0 0 1 1.400.600l6.300 6.300a2 2 0 0 1 0 2.800l-6.700 6.700a2 2 0 0 1-2.800 0l-6.300-6.300a2 2 0 0 1-.600-1.400Z" /><circle cx="8" cy="8" r="1.200" /></I>,
  panel: () => <I><rect x="3" y="4.500" width="18" height="15" rx="2.500" /><path d="M15 4.500v15" /></I>,
  layersPlus: () => <I><path d="m12 3.500 8.500 4.500-8.500 4.500-8.500-4.500Z" /><path d="m3.500 12.500 8.500 4.500 3-1.600" /><path d="M19 14.500v6M16 17.500h6" /></I>,
  arrowUpRight: () => <I size={14}><path d="M7 17 17 7M9 7h8v8" /></I>,
};
