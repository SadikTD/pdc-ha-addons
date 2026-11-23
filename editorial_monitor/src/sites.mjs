// The four sites. board: the slug on the Gamurs board; wp: the WordPress address (OS
// only answers on www.); interlinks: how many the guide asks for (Attack needs one).
// primaryCategory is a setting because OS files its stories under Curveball, not News.
export const SITES = [
  { id: 'wgtc', label: 'WGTC', name: 'We Got This Covered', board: 'wgtc', wp: 'https://wegotthiscovered.com', interlinks: 2, primaryCategory: 'News', topicCategory: true },
  { id: 'tms', label: 'TMS', name: 'The Mary Sue', board: 'tms', wp: 'https://www.themarysue.com', interlinks: 2, primaryCategory: 'News', topicCategory: true },
  { id: 'os', label: 'OS', name: 'Operation Sports', board: 'os-curveball', wp: 'https://www.operationsports.com', interlinks: 2, primaryCategory: 'Curveball', topicCategory: false },
  { id: 'aotf', label: 'AOTF', name: 'Attack of the Fanboy', board: 'aotf', wp: 'https://attackofthefanboy.com', interlinks: 1, primaryCategory: 'News', topicCategory: true },
];
export const siteById = id => SITES.find(s => s.id === id);
// A site with its saved overrides (Settings > Sites).
export const withSettings = (site, settings) => ({ ...site, ...(settings.sites?.[site.id] || {}) });
