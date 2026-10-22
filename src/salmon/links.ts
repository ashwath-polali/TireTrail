// Official salmon habitat and 6PPDQ maps, checked Oct 22 2026, and the credits for the salmon layer.

export const HABITAT_LINKS: readonly { label: string; by: string; url: string }[] = [
  { label: 'SalmonScape', by: 'WDFW salmon streams map', url: 'https://apps.wdfw.wa.gov/salmonscape/' },
  { label: '6PPDQ heat map', by: 'USGS', url: 'https://geonarrative.usgs.gov/6ppdqsourcedashboard/' },
  // its story map of tire contaminants in salmon watersheds is linked from here
  { label: '6PPD and 6PPDQ', by: 'WA Ecology', url: 'https://ecology.wa.gov/waste-toxics/reducing-toxic-chemicals/addressing-priority-toxic-chemicals/6ppd' },
];

export const SALMON_CREDITS = [
  'WDFW and NWIFC SWIFD, Statewide Washington Integrated Fish Distribution (salmon and steelhead streams)',
  'USGS National Hydrography Dataset (stream names)',
];
