module.exports = [
  { name: 'Sandbach United', handle: 'SandbachFC_1st' },
  { name: 'Eccleshall', handle: 'EccleshallFC' },
  { name: 'New Mills', handle: 'NewMillsFC' },
  { name: 'Stafford Town', handle: 'StaffordTown1st' },
  { name: 'Telford Town', handle: 'TelfordTownFC' },
  { name: 'Crewe', handle: 'crewefc' },
  { name: 'Widnes Town', handle: 'Widnes_FC' },
  { name: 'Wednesfield Community', handle: 'WednesfieldCFC' },
  { name: 'Alsager Town', handle: 'alsagertown_fc' },
  { name: 'Allscott Heath', handle: 'AllscottHeathFC' },
  { name: 'Barnton', handle: 'barntonfc' },
  { name: 'Bilston Town', handle: 'bilstontownfc' },
  { name: 'AFC Bridgnorth', handle: 'AFCBridgnorth' },
  { name: 'Brereton Social', handle: 'breretonsocialf' },
  { name: 'Cheadle Heath Nomads', handle: 'CheadleNomads' },
  { name: 'Dawley Town', handle: 'DawleyTownFC' },
  { name: 'Market Drayton Town', handle: 'MDTFC' },
  { name: 'Shawbury United', handle: 'shawburyutd' },
  { name: 'Wolverhampton Casuals', handle: 'WolvesCassies' },
  { name: 'Foley Meir', handle: 'foley_fc' },
  // 'NWCFL (League Official)' (handle 'nwcfl') removed — it was being
  // fetched by division-posts.js on every run (a GetXAPI call for nothing),
  // but can never match a fixture's home/away team name, so its posts were
  // never actually read anywhere (checked division-recap-engine.js's
  // relevantClubNames filter and every other CLUBS lookup in the codebase).
];