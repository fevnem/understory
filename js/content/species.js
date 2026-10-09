// The vocabulary of the forest: twelve species, each with a habit the renderer can build
// parametrically and a note the garden can show. Species spelling is FROZEN — the timer
// chooses one per tree id, `js/gl/forest.js` renders it, `js/ui/garden.js` labels it.

export const SPECIES = [
  { id: 'birch',    name: 'Birch',        latin: 'Betula pendula',   habit: 'slender',  hue: 44,  height: 1.05, seedShape: 'winged',  note: 'Grows fast and bends in wind. The first tree in bare ground.' },
  { id: 'scots',    name: 'Scots pine',   latin: 'Pinus sylvestris', habit: 'conifer',  hue: 104, height: 1.25, seedShape: 'winged',  note: 'Bare trunk, crown high up. Old ones look like weather.' },
  { id: 'sessile',  name: 'Oak',          latin: 'Quercus petraea',  habit: 'broad',    hue: 78,  height: 1.35, seedShape: 'acorn',   note: 'Slow. Takes decades to look like anything; outlives the argument.' },
  { id: 'rowan',    name: 'Rowan',        latin: 'Sorbus aucuparia', habit: 'slender',  hue: 96,  height: 0.9,  seedShape: 'berry',   note: 'Quick to fruit and quick to fade. A short honest tree.' },
  { id: 'willow',   name: 'Willow',       latin: 'Salix alba',       habit: 'weeping',  hue: 66,  height: 1.1,  seedShape: 'catkin',  note: 'Hangs over water. Moves more than the wind asks it to.' },
  { id: 'beech',    name: 'Beech',        latin: 'Fagus sylvatica',  habit: 'broad',    hue: 88,  height: 1.3,  seedShape: 'mast',    note: 'Dense canopy. Almost nothing grows underneath, and that is fine.' },
  { id: 'larch',    name: 'Larch',        latin: 'Larix decidua',    habit: 'conifer',  hue: 118, height: 1.2,  seedShape: 'winged',  note: 'The conifer that loses its needles. Winter reads as failure; it is not.' },
  { id: 'aspen',    name: 'Aspen',        latin: 'Populus tremula',  habit: 'columnar', hue: 60,  height: 1.15, seedShape: 'catkin',  note: 'Slightest air moves the whole leaf. Restless, in a good way.' },
  { id: 'hazel',    name: 'Hazel',        latin: 'Corylus avellana', habit: 'clumping', hue: 74,  height: 0.75, seedShape: 'nut',     note: 'Many stems from one root. Returns after being cut.' },
  { id: 'ginkgo',   name: 'Ginkgo',       latin: 'Ginkgo biloba',    habit: 'columnar', hue: 52,  height: 1.0,  seedShape: 'fleshy',  note: 'Older than the hills it stands on. Barely changed.' },
  { id: 'juniper',  name: 'Juniper',      latin: 'Juniperus communis', habit: 'conifer', hue: 132, height: 0.65, seedShape: 'cone',    note: 'Small, slow, and hard to kill. The soundest tree in the wood.' },
  { id: 'hornbeam', name: 'Hornbeam',     latin: 'Carpinus betulus', habit: 'columnar', hue: 92,  height: 1.15, seedShape: 'nutlet',  note: 'The hardest wood in the forest. It was never asked to be beautiful.' }
];

export const SPECIES_BY_ID = SPECIES.reduce(function (acc, s) { acc[s.id] = s; return acc; }, {});

export function speciesFor(id) {
  return SPECIES_BY_ID[id] || SPECIES[0];
}
