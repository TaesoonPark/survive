import type { StringTable } from './types';

/**
 * English display text.
 *
 * Every name and description the player reads for a piece of game content lives here
 * rather than beside the numbers that define it. Splitting the two is what makes another
 * language a data change instead of a sweep through the content tables - and it means a
 * translator gets one file, not nine.
 *
 * Keyed by definition id. The table's type demands an entry for every id the content
 * tables declare, so a new item cannot ship without the text to display it; `strings.test`
 * checks the reverse direction, that nothing here names content that no longer exists.
 */
export const EN: StringTable = {
  /** Items: everything that can sit in a slot. */
  items: {
    alcohol_moonshine: {
      name: 'Moonshine',
      description: 'Fruit mash run through a still. Painkiller, antiseptic, terrible idea.',
    },
    ammo_308: {
      name: '.308 Round',
      description: 'Full-power rifle brass. Six of them are a plan.',
    },
    ammo_9mm: {
      name: '9mm Round',
      description: 'Common before, precious now.',
    },
    ammo_casing: {
      name: 'Cartridge Casing',
      description: 'Drawn brass, ready to be primed, charged and crimped.',
    },
    ammo_shell: {
      name: 'Shotgun Shell',
      description: 'Plastic hull, brass base, a handful of lead.',
    },
    antibiotics: {
      name: 'Antibiotics',
      description: 'A short course of pills. The only thing that reliably stops sepsis.',
    },
    antiseptic: {
      name: 'Antiseptic',
      description: 'Stings like betrayal. Buys a wound a day of grace.',
    },
    anvil_kit: {
      name: 'Anvil Kit',
      description: 'A block of iron on a stump. Absurdly heavy, and steel needs it.',
    },
    apple: {
      name: 'Apple',
      description: 'Bruised on one side. Still an apple.',
    },
    arrow_iron: {
      name: 'Iron Arrow',
      description: 'Heavier head, punches through a leather jacket and whatever is wearing it.',
    },
    arrow_wooden: {
      name: 'Wooden Arrow',
      description: 'Fire-hardened shaft, flint head. Usually survives to be pulled out again.',
    },
    backpack_large: {
      name: 'Large Backpack',
      description: 'A hiking frame pack. Sixteen slots, and you feel every one of them.',
    },
    backpack_small: {
      name: 'Small Backpack',
      description: 'Eight more pockets. The single biggest quality-of-life upgrade in the game.',
    },
    baked_potato: {
      name: 'Baked Potato',
      description: 'Ash on the skin, steam in the middle.',
    },
    bandage_clean: {
      name: 'Clean Bandage',
      description: 'Boiled cloth, dried in the sun. Enormously better than a rag.',
    },
    bandage_dirty: {
      name: 'Dirty Bandage',
      description: 'Torn rag, wrapped tight. Stops the bleeding and invites the infection.',
    },
    bandage_sterile: {
      name: 'Sterile Dressing',
      description: 'Sealed, antiseptic-soaked gauze. Nothing gets in behind it.',
    },
    bark: {
      name: 'Bark',
      description: 'Strips of bark. Tannin for curing hides, tinder for a fire.',
    },
    baseball_bat: {
      name: 'Baseball Bat',
      description: 'Ash, taped grip, somebody else’s initials burned into the barrel.',
    },
    battery: {
      name: 'Battery',
      description: 'Most of a charge left. Radios and torches only.',
    },
    beans: {
      name: 'Beans',
      description: 'Keeps producing all season if you let it climb.',
    },
    bed_kit: {
      name: 'Bed Kit',
      description: 'Frame, slats and a stuffed mattress. Sleep is how you get the night back.',
    },
    berry: {
      name: 'Berries',
      description: 'A handful off a bush. Sweet, wet, and gone in a second.',
    },
    bolt: {
      name: 'Crossbow Bolt',
      description: 'Short, thick and mean. Made to be recovered.',
    },
    bone: {
      name: 'Bone',
      description: 'Sturdy and sharp when split. Burned to ash it makes fertiliser and powder.',
    },
    bread: {
      name: 'Bread',
      description:
        'A dense flat loaf. Keeps for days and fills you like nothing else you can grow.',
    },
    cabbage: {
      name: 'Cabbage',
      description: 'A dense head of leaves. Survives frost that kills everything else.',
    },
    campfire_kit: {
      name: 'Campfire Kit',
      description: 'A ring of stones and a bundle of kindling. Light, warmth, cooking, safety.',
    },
    canned_beans: {
      name: 'Canned Beans',
      description: 'Dented tin, intact seal. Somebody stocked a cupboard and never came home.',
    },
    canned_soup: {
      name: 'Canned Soup',
      description: 'Cold from the tin, and still the highlight of the week.',
    },
    canteen: {
      name: 'Canteen',
      description: 'Metal, felt-covered, holds six. Refills at any water you can reach.',
    },
    carrot: {
      name: 'Carrot',
      description: 'Crisp and startlingly sweet.',
    },
    charcoal: {
      name: 'Charcoal',
      description: 'Wood cooked without air. Smelting fuel, and the black half of gunpowder.',
    },
    chemistry_bench_kit: {
      name: 'Chemistry Bench Kit',
      description: 'Glassware, burner and a scavenged bench top. Medicine and powder.',
    },
    chocolate_bar: {
      name: 'Chocolate Bar',
      description: 'Bloomed grey with age. Sugar is sugar.',
    },
    clay: {
      name: 'Clay',
      description: 'Wet grey clay dug out of a riverbank. Mortar now, brick after firing.',
    },
    clay_brick: {
      name: 'Clay Brick',
      description: 'Kiln-fired and hard. Lines a burner without cracking.',
    },
    cloth: {
      name: 'Cloth',
      description: 'A woven square. Clothing, bandages, packs.',
    },
    cloth_pants: {
      name: 'Cloth Pants',
      description: 'Two legs of woven fibre held up with cord.',
    },
    cloth_rag: {
      name: 'Cloth Rag',
      description: 'A torn scrap of fabric. Dirty, but it soaks up blood.',
    },
    cloth_shirt: {
      name: 'Cloth Shirt',
      description: 'Homespun and shapeless. Better than bare skin, barely.',
    },
    coal: {
      name: 'Coal',
      description: 'Dense black rock that burns hotter and longer than anything you can grow.',
    },
    coffee: {
      name: 'Coffee',
      description: 'Stale grounds, boiled twice. Buys you an hour you have not earned.',
    },
    compass: {
      name: 'Compass',
      description:
        'Points north whatever the weather does. Cheap insurance against walking in circles.',
    },
    compost: {
      name: 'Compost',
      description: 'A season of kitchen scraps, gone black and sweet-smelling.',
    },
    cooked_fish: {
      name: 'Cooked Fish',
      description: 'Flaky and salty. Quiet food, honestly earned.',
    },
    cooked_meat: {
      name: 'Cooked Meat',
      description: 'Charred outside, hot through. The single best reason to keep a fire.',
    },
    cooking_pot_kit: {
      name: 'Cooking Pot',
      description: 'A beaten iron pot and tripod. Soups, stews and boiled water in quantity.',
    },
    copper_ingot: {
      name: 'Copper Ingot',
      description: 'Soft, conductive, easy to work. Wire and cartridge brass.',
    },
    copper_ore: {
      name: 'Copper Ore',
      description: 'Green-streaked rock. Soft metal, but it draws into wire and cases a round.',
    },
    corn: {
      name: 'Corn',
      description: 'Heavy cob, bright kernels. Food, feed and the base of any still.',
    },
    crossbow: {
      name: 'Crossbow',
      description: 'Slow to crank, brutal on release, and it barely whispers.',
    },
    crowbar: {
      name: 'Crowbar',
      description: 'Prying tool first, weapon second, and never quite bad at either.',
    },
    disinfected_rag: {
      name: 'Disinfected Rag',
      description: 'A rag soaked in antiseptic. Field-grade, and it works.',
    },
    door_key: {
      name: 'Door Key',
      description: 'Cut for one lock somewhere. Worth carrying until you find out which.',
    },
    dough: {
      name: 'Dough',
      description: 'Flour and water, kneaded. One fire away from bread.',
    },
    duct_tape: {
      name: 'Duct Tape',
      description: 'Half a roll left. Fixes everything, once.',
    },
    egg: {
      name: 'Egg',
      description: 'Warm from the nest. Fragile in a pack full of stone.',
    },
    energy_bar: {
      name: 'Energy Bar',
      description: 'Tastes like cardboard, hits like a slap. Eat it while running.',
    },
    farm_plot_kit: {
      name: 'Farm Plot Kit',
      description: 'Edging boards and a bag of good soil. Turns dirt into a crop bed.',
    },
    feather: {
      name: 'Feather',
      description: 'Fletching. Without it an arrow is just a stick going roughly forward.',
    },
    fertilizer: {
      name: 'Fertilizer',
      description: 'Bone meal and rotted greens. Buys back the fertility a harvest takes.',
    },
    first_aid_kit: {
      name: 'First Aid Kit',
      description: 'Green box, white cross, three uses left. Everything in one place for once.',
    },
    fishing_rod: {
      name: 'Fishing Rod',
      description: 'Stick, line, bent nail. Quiet food, if you can sit still.',
    },
    flashlight: {
      name: 'Flashlight',
      description: 'A tight cone of light and a battery that is always nearly done.',
    },
    flint: {
      name: 'Flint',
      description: 'Knaps to a shaving edge and throws a spark. Two problems, one stone.',
    },
    flour: {
      name: 'Flour',
      description: 'Wheat put through a grindstone. Edible dry, in the way sand is.',
    },
    fuel_canister: {
      name: 'Fuel Canister',
      description:
        'Jerrycan of petrol, going stale but still furious. Burns hotter than anything else you own.',
    },
    furnace_kit: {
      name: 'Furnace Kit',
      description: 'Dressed block and raw clay for the lining. Iron begins here.',
    },
    gas_mask: {
      name: 'Gas Mask',
      description:
        'Filters still good. Breathing is the only thing it helps with, and sometimes that is everything.',
    },
    glass: {
      name: 'Glass Pane',
      description: 'Cast flat and cooled slowly. Windows, lanterns, bottles.',
    },
    glass_shard: {
      name: 'Glass Shard',
      description: 'A broken edge. Cuts whatever holds it about as often as what it is aimed at.',
    },
    grindstone_kit: {
      name: 'Grindstone Kit',
      description: 'A dressed wheel and a crank. Wheat into flour, edges back onto tools.',
    },
    gunpowder: {
      name: 'Gunpowder',
      description: 'Charcoal, saltpetre and bone ash, milled fine. Handle it dry and gently.',
    },
    hammer: {
      name: 'Hammer',
      description: 'Drives nails, dresses stone, and settles arguments.',
    },
    hard_hat: {
      name: 'Hard Hat',
      description: 'Site helmet. Designed for falling bricks, repurposed for falling teeth.',
    },
    herb: {
      name: 'Medicinal Herb',
      description: 'Bitter leaves. Steeped for pain, mashed for wounds, mouldered for antibiotics.',
    },
    hide: {
      name: 'Animal Hide',
      description: 'Raw, greasy and starting to smell. Tan it before it turns.',
    },
    hoe: {
      name: 'Hoe',
      description: 'Breaks sod into a seed bed. Farming starts with this or not at all.',
    },
    hunting_bow: {
      name: 'Hunting Bow',
      description: 'Stick, sinew, patience. Kills deer and walkers without telling the street.',
    },
    iron_axe: {
      name: 'Iron Axe',
      description: 'A proper felling axe. Trees stop being an afternoon and become a minute.',
    },
    iron_ingot: {
      name: 'Iron Ingot',
      description: 'Smelted iron. The line between scraping by and building something.',
    },
    iron_knife: {
      name: 'Iron Knife',
      description: 'Thin, quick, and it keeps its edge. Butchering and back alleys.',
    },
    iron_ore: {
      name: 'Iron Ore',
      description: 'Rust-red rock. Worthless without a furnace, priceless with one.',
    },
    iron_pickaxe: {
      name: 'Iron Pickaxe',
      description: 'The tool that opens up iron and copper. Everything metal waits behind it.',
    },
    iron_sword: {
      name: 'Iron Sword',
      description: 'Somebody’s idea of a sword, forged from what was to hand. It works.',
    },
    jeans: {
      name: 'Jeans',
      description: 'Denim. Tougher than it has any right to be.',
    },
    jerky: {
      name: 'Jerky',
      description: 'Dried over a low fire for hours. Ugly, tough, and it does not rot.',
    },
    kevlar_vest: {
      name: 'Kevlar Vest',
      description: 'Soft armour under a nylon shell. Stops bullets, does nothing for your arms.',
    },
    kitchen_knife: {
      name: 'Kitchen Knife',
      description: 'Out of somebody’s drawer. Fine for onions, honest about anything larger.',
    },
    lantern: {
      name: 'Lantern',
      description: 'Glass, wick and a reservoir. Brighter and far longer-lived than a torch.',
    },
    leather: {
      name: 'Leather',
      description: 'Cured hide. Turns a bite into a bruise more often than it does not.',
    },
    leather_cap: {
      name: 'Leather Cap',
      description: 'Stops a scrape and keeps the rain out. That is the extent of it.',
    },
    leather_gloves: {
      name: 'Leather Gloves',
      description: 'Saves your hands from thorns, glass and the occasional set of teeth.',
    },
    leather_jacket: {
      name: 'Leather Jacket',
      description: 'Thick hide, long sleeves. Teeth catch on it instead of in you.',
    },
    leather_pants: {
      name: 'Leather Pants',
      description: 'Stiff, hot, and hard to bite through. Crawlers go for legs.',
    },
    lighter: {
      name: 'Lighter',
      description: 'A few dozen flicks left in it. Worth more than it looks on a wet night.',
    },
    lockpick: {
      name: 'Lockpick',
      description: 'Bent wire and a tension bar. Opens what you did not build, sometimes.',
    },
    loom_kit: {
      name: 'Loom Kit',
      description: 'Frame, beater and heddles. Fibre becomes cloth, hide becomes leather.',
    },
    machete: {
      name: 'Machete',
      description: 'Long, heavy at the tip, and it takes an arm off at the elbow.',
    },
    map: {
      name: 'Regional Map',
      description: 'Folded, torn along the creases. Reveals the ground around you as you go.',
    },
    molotov: {
      name: 'Molotov Cocktail',
      description: 'A bottle, a rag and a bad idea. Burns a doorway shut for a minute.',
    },
    morphine: {
      name: 'Morphine',
      description: 'One ampoule. Erases pain completely, and your judgement with it.',
    },
    motorcycle_helmet: {
      name: 'Motorcycle Helmet',
      description: 'Full face, tinted visor. They can bite it all day.',
    },
    multitool: {
      name: 'Multitool',
      description:
        'Pre-collapse alloy, still tight in the joints. Four tools in a pocket, and irreplaceable.',
    },
    mushroom: {
      name: 'Wild Mushroom',
      description: 'Probably the edible kind. Probably.',
    },
    nail: {
      name: 'Nail',
      description: 'Small, dull, and the reason your roof stays on.',
    },
    nail_bat: {
      name: 'Nail Bat',
      description: 'A bat with a dozen nails hammered through it. Every hit tears on the way out.',
    },
    onion: {
      name: 'Onion',
      description: 'Sharp raw, transformative in a pot.',
    },
    painkiller: {
      name: 'Painkillers',
      description: 'Two white tablets. Pain goes quiet; the injury does not go away.',
    },
    pistol_9mm: {
      name: '9mm Pistol',
      description:
        'Fifteen rounds and a very loud opinion. Everything within four chunks hears it.',
    },
    pitchfork: {
      name: 'Pitchfork',
      description: 'Four tines, farm-length handle. Pins one and pushes two.',
    },
    plant_fiber: {
      name: 'Plant Fiber',
      description:
        'Tough stringy stems. The first thing anyone gathers, and the last thing they run out of.',
    },
    plastic: {
      name: 'Plastic Scrap',
      description: 'Cracked panels and bottle bodies. Light, waterproof, everywhere.',
    },
    plate_carrier: {
      name: 'Plate Carrier',
      description:
        'Ceramic plates front and back. Heavy, hot, and the best decision you will make.',
    },
    potato: {
      name: 'Potato',
      description: 'Dirt-caked and dense. Grows anywhere, keeps forever, tastes of nothing.',
    },
    pumpkin: {
      name: 'Pumpkin',
      description: 'Absurdly heavy, absurdly filling. Worth the two weeks.',
    },
    radio: {
      name: 'Radio',
      description: 'Mostly static. Occasionally a voice, and then you have a decision to make.',
    },
    raw_fish: {
      name: 'Raw Fish',
      description: 'Still slick. Bones and all if you are desperate.',
    },
    raw_meat: {
      name: 'Raw Meat',
      description: 'Butchered and bloody. Cook it unless you enjoy fever dreams.',
    },
    resin: {
      name: 'Pine Resin',
      description: 'Sticky sap. Glue, waterproofing, and it makes a torch burn honestly.',
    },
    rifle_308: {
      name: '.308 Hunting Rifle',
      description: 'Reaches across a field and ends the argument. Then the field fills up.',
    },
    rope: {
      name: 'Rope',
      description: 'Twisted fibre cordage. Lashings, bowstrings, snares.',
    },
    rubber: {
      name: 'Rubber',
      description: 'Cut from a tyre wall. Seals, straps, sling bands.',
    },
    sand: {
      name: 'Sand',
      description: 'Silica. Useless until it is molten.',
    },
    saw: {
      name: 'Saw',
      description: 'Turns logs into planks instead of splinters.',
    },
    schematic_ammunition: {
      name: 'Schematic: Handloading',
      description: 'A reloading table torn from a manual. Charges, crimps, seating depths.',
    },
    schematic_crossbow: {
      name: 'Schematic: Crossbow',
      description: 'Drawings of a prod, a nut and a trigger. Quiet, lethal, and not obvious.',
    },
    schematic_medicine: {
      name: 'Schematic: Field Pharmacy',
      description: 'Culturing notes in a careful hand. How to grow a cure in a jar.',
    },
    schematic_steel: {
      name: 'Schematic: Crucible Steel',
      description: 'Water-stained notes on carburising iron. Hours of somebody else’s work.',
    },
    scrap_metal: {
      name: 'Scrap Metal',
      description: 'Twisted offcuts of the old world. Re-smelt it, or nail it to something.',
    },
    seed_beans: {
      name: 'Bean Seed',
      description: 'Give it something to climb and it keeps giving back.',
    },
    seed_cabbage: {
      name: 'Cabbage Seed',
      description: 'Cold-hardy. The last thing still growing in autumn.',
    },
    seed_carrot: {
      name: 'Carrot Seed',
      description: 'Dust-fine seed. Sow thick, thin later.',
    },
    seed_corn: {
      name: 'Corn Seed',
      description: 'Dried kernels. Slow, heavy, worth it.',
    },
    seed_herb: {
      name: 'Herb Seed',
      description: 'Wild medicinal seed. The start of a medicine cabinet.',
    },
    seed_onion: {
      name: 'Onion Set',
      description: 'Small bulbs ready to go back in the ground.',
    },
    seed_potato: {
      name: 'Seed Potato',
      description: 'A sprouting tuber, cut to the eyes.',
    },
    seed_pumpkin: {
      name: 'Pumpkin Seed',
      description: 'Flat white seeds. Needs room and a whole season.',
    },
    seed_tomato: {
      name: 'Tomato Seed',
      description: 'Scraped from a ripe fruit and dried on paper.',
    },
    seed_wheat: {
      name: 'Wheat Seed',
      description: 'A palmful of grain held back from the last harvest.',
    },
    shotgun: {
      name: 'Pump Shotgun',
      description: 'Eight pellets of instant regret at close range. Also a dinner bell.',
    },
    shovel: {
      name: 'Shovel',
      description: 'Digs clay, sand and graves.',
    },
    sickle: {
      name: 'Sickle',
      description: 'Harvests grain and fibre in armfuls rather than handfuls.',
    },
    sinew: {
      name: 'Sinew',
      description: 'Dried tendon. Stronger than any cord you can twist from grass.',
    },
    sledgehammer: {
      name: 'Sledgehammer',
      description: 'Slow as a season, and nothing it connects with gets back up. Doors included.',
    },
    soda: {
      name: 'Soda',
      description: 'Flat, warm, and 40 grams of sugar.',
    },
    soup_vegetable: {
      name: 'Vegetable Soup',
      description: 'Whatever was in the plot, boiled to nothing. Hot, wet and enormously welcome.',
    },
    spear: {
      name: 'Spear',
      description: 'Reach. The only thing standing between you and a bite you cannot take back.',
    },
    splint_medical: {
      name: 'Medical Splint',
      description: 'Padded alloy stay with proper straps. Sets a fracture and lets you walk.',
    },
    splint_wood: {
      name: 'Wooden Splint',
      description: 'Two sticks and a rag. Sets a break badly, which beats not at all.',
    },
    steel_axe: {
      name: 'Steel Axe',
      description: 'Forged, tempered, and balanced. Bites deeper than iron and shrugs it off.',
    },
    steel_ingot: {
      name: 'Steel Ingot',
      description: 'Iron married to carbon in a hot fire. Holds an edge through a whole horde.',
    },
    steel_pickaxe: {
      name: 'Steel Pickaxe',
      description: 'Hardened point, sprung haft. Boulders come apart in handfuls.',
    },
    stew_meat: {
      name: 'Meat Stew',
      description: 'Meat, roots and stock. The best meal in the world after four days of berries.',
    },
    stick: {
      name: 'Stick',
      description: 'A trimmed branch. Handles, shafts, kindling.',
    },
    stone: {
      name: 'Stone',
      description: 'A hand-sized rock. Sharp enough to cut with, heavy enough to build with.',
    },
    stone_block: {
      name: 'Stone Block',
      description: 'Dressed masonry. Heavy, slow to make, and it does not burn.',
    },
    stone_hatchet: {
      name: 'Stone Hatchet',
      description:
        'A flake of stone lashed to a branch. It will fell a tree and it will fall apart.',
    },
    stone_knife: {
      name: 'Stone Knife',
      description: 'A knapped flint edge. It skins, it whittles, it wears out.',
    },
    stone_pickaxe: {
      name: 'Stone Pickaxe',
      description: 'Blunt and brittle. Enough for loose rock and coal, hopeless on ore.',
    },
    storage_box_kit: {
      name: 'Storage Box Kit',
      description: 'Flat-packed crate. Twenty slots that are not on your back.',
    },
    suture_kit: {
      name: 'Suture Kit',
      description: 'Needle, sinew and a steady hand. Closes what a bandage only covers.',
    },
    tea_herbal: {
      name: 'Herbal Tea',
      description: 'Willow bark and bitter leaves. Takes the edge off an ache.',
    },
    throwing_rock: {
      name: 'Throwing Rock',
      description:
        'A fist-sized stone picked for balance. Barely hurts, but it lands somewhere you are not.',
    },
    tomato: {
      name: 'Tomato',
      description: 'Splits if you look at it wrong. Mostly water, and that is the point.',
    },
    tool_belt: {
      name: 'Tool Belt',
      description:
        'Four loops of leather at the hip. Fewer slots than a pack, no weight on your back, and craftable on day one.',
    },
    torch: {
      name: 'Torch',
      description:
        'Resin-soaked fibre on a stick. Held it lights your way; driven into a wall it lights a room.',
    },
    vitamins: {
      name: 'Vitamins',
      description: 'A jar of chalky tablets. Slow, boring, genuinely useful.',
    },
    water_barrel_kit: {
      name: 'Water Barrel Kit',
      description: 'Staves, hoops and pitch. Collects rain so you stop walking to the pond.',
    },
    water_bottle: {
      name: 'Water Bottle',
      description: 'Scratched plastic, screw cap. Four swallows of carried safety.',
    },
    water_clean: {
      name: 'Clean Water',
      description: 'Boiled and cooled. The most underrated item in the world.',
    },
    water_dirty: {
      name: 'Dirty Water',
      description: 'Scooped from a pond. It will keep you alive and then make you wish it had not.',
    },
    watering_can: {
      name: 'Watering Can',
      description: 'Beaten from scrap. Carries enough for a bed of crops, if you walk carefully.',
    },
    wheat: {
      name: 'Wheat',
      description: 'A bundle of ripe ears. Inedible until it has been through a grindstone.',
    },
    wire: {
      name: 'Wire',
      description: 'Drawn copper. Snares, traps, and anything that needs to conduct.',
    },
    wood_log: {
      name: 'Wood Log',
      description: 'A rough length of trunk. Everything wooden starts here.',
    },
    wood_plank: {
      name: 'Wood Plank',
      description: 'Sawn flat and square. Structural, and far less wasteful than logs.',
    },
    wooden_club: {
      name: 'Wooden Club',
      description: 'A log with one end narrowed. Crude, and it caves a skull in anyway.',
    },
    work_boots: {
      name: 'Work Boots',
      description: 'Steel toes, thick soles. You can stamp on things.',
    },
    work_gloves: {
      name: 'Work Gloves',
      description: 'Reinforced palms. Hauling stone stops taking skin off.',
    },
    workbench_kit: {
      name: 'Workbench Kit',
      description: 'Trestles and a top, ready to assemble. Everything worth making needs it.',
    },
    wrench: {
      name: 'Wrench',
      description: 'Strips a car down to its useful bones.',
    },
  },
  /** Recipes, as they appear in the crafting list. */
  recipes: {
    bake_bread: { name: 'Bread' },
    bake_potato: { name: 'Baked Potato' },
    boil_water: { name: 'Boil Water' },
    boil_water_batch: { name: 'Boil Water (Batch)' },
    brew_tea_herbal: { name: 'Herbal Tea' },
    cook_fish: { name: 'Cooked Fish' },
    cook_meat: { name: 'Cooked Meat' },
    cook_soup_vegetable: { name: 'Vegetable Soup' },
    cook_stew_meat: { name: 'Meat Stew' },
    craft_anvil_kit: { name: 'Anvil Kit' },
    craft_arrow_iron: { name: 'Iron Arrows' },
    craft_arrow_wooden: { name: 'Wooden Arrows' },
    craft_bandage_dirty: { name: 'Dirty Bandage' },
    craft_bed_kit: { name: 'Bed Kit' },
    craft_bolt: { name: 'Crossbow Bolts' },
    craft_campfire_kit: { name: 'Campfire Kit' },
    craft_chemistry_bench_kit: { name: 'Chemistry Bench Kit' },
    craft_cloth_rag: { name: 'Cloth Rag' },
    craft_cooking_pot_kit: { name: 'Cooking Pot' },
    craft_crossbow: { name: 'Crossbow' },
    craft_disinfected_rag: { name: 'Disinfected Rag' },
    craft_farm_plot_kit: { name: 'Farm Plot Kit' },
    craft_fishing_rod: { name: 'Fishing Rod' },
    craft_furnace_kit: { name: 'Furnace Kit' },
    craft_grindstone_kit: { name: 'Grindstone Kit' },
    craft_hammer: { name: 'Hammer' },
    craft_hoe: { name: 'Hoe' },
    craft_hunting_bow: { name: 'Hunting Bow' },
    craft_iron_axe: { name: 'Iron Axe' },
    craft_iron_knife: { name: 'Iron Knife' },
    craft_iron_pickaxe: { name: 'Iron Pickaxe' },
    craft_lantern: { name: 'Lantern' },
    craft_lockpick: { name: 'Lockpick' },
    craft_loom_kit: { name: 'Loom Kit' },
    craft_nail: { name: 'Nails' },
    craft_nail_bat: { name: 'Nail Bat' },
    craft_pitchfork: { name: 'Pitchfork' },
    craft_rag_from_cloth: { name: 'Tear Cloth Into Rags' },
    craft_rope: { name: 'Rope' },
    craft_saw: { name: 'Saw' },
    craft_shovel: { name: 'Shovel' },
    craft_sickle: { name: 'Sickle' },
    craft_sledgehammer: { name: 'Sledgehammer' },
    craft_spear: { name: 'Spear' },
    craft_splint_medical: { name: 'Medical Splint' },
    craft_splint_wood: { name: 'Wooden Splint' },
    craft_stick: { name: 'Sticks' },
    craft_stone_block: { name: 'Stone Block' },
    craft_stone_hatchet: { name: 'Stone Hatchet' },
    craft_stone_knife: { name: 'Stone Knife' },
    craft_stone_pickaxe: { name: 'Stone Pickaxe' },
    craft_storage_box_kit: { name: 'Storage Box Kit' },
    craft_suture_kit: { name: 'Suture Kit' },
    craft_throwing_rock: { name: 'Throwing Rocks' },
    craft_torch: { name: 'Torch' },
    craft_water_barrel_kit: { name: 'Water Barrel Kit' },
    craft_watering_can: { name: 'Watering Can' },
    craft_wire: { name: 'Wire' },
    craft_wood_plank: { name: 'Wood Planks' },
    craft_wooden_club: { name: 'Wooden Club' },
    craft_workbench_kit: { name: 'Workbench Kit' },
    craft_wrench: { name: 'Wrench' },
    distill_moonshine: { name: 'Moonshine (Fruit)' },
    distill_moonshine_corn: { name: 'Moonshine (Corn)' },
    fire_clay_brick: { name: 'Clay Brick' },
    forge_ammo_308: { name: '.308 Rounds' },
    forge_ammo_9mm: { name: '9mm Rounds' },
    forge_ammo_casing: { name: 'Cartridge Casings' },
    forge_ammo_shell: { name: 'Shotgun Shells' },
    forge_crowbar: { name: 'Crowbar' },
    forge_iron_sword: { name: 'Iron Sword' },
    forge_machete: { name: 'Machete' },
    forge_steel_axe: { name: 'Steel Axe' },
    forge_steel_pickaxe: { name: 'Steel Pickaxe' },
    make_antibiotics: { name: 'Antibiotics' },
    make_antiseptic: { name: 'Antiseptic' },
    make_bandage_clean: { name: 'Clean Bandage' },
    make_bandage_sterile: { name: 'Sterile Dressing' },
    make_compost: { name: 'Compost' },
    make_dough: { name: 'Dough' },
    make_fertilizer: { name: 'Fertilizer' },
    make_first_aid_kit: { name: 'First Aid Kit' },
    make_gunpowder: { name: 'Gunpowder' },
    make_jerky: { name: 'Jerky' },
    make_molotov: { name: 'Molotov Cocktail' },
    make_painkiller: { name: 'Painkillers' },
    mill_bone_meal: { name: 'Bone Meal' },
    mill_flour: { name: 'Flour' },
    sew_backpack_large: { name: 'Large Backpack' },
    sew_backpack_small: { name: 'Small Backpack' },
    sew_cloth_pants: { name: 'Cloth Pants' },
    sew_cloth_shirt: { name: 'Cloth Shirt' },
    sew_leather_cap: { name: 'Leather Cap' },
    sew_leather_gloves: { name: 'Leather Gloves' },
    sew_leather_jacket: { name: 'Leather Jacket' },
    sew_leather_pants: { name: 'Leather Pants' },
    sew_tool_belt: { name: 'Tool Belt' },
    smelt_charcoal: { name: 'Charcoal' },
    smelt_copper_ingot: { name: 'Copper Ingot' },
    smelt_glass: { name: 'Glass Pane' },
    smelt_glass_from_shards: { name: 'Recast Glass' },
    smelt_iron_ingot: { name: 'Iron Ingot' },
    smelt_scrap_to_iron: { name: 'Re-smelt Scrap' },
    smelt_steel_ingot: { name: 'Steel Ingot' },
    tan_leather: { name: 'Tan Leather' },
    weave_cloth_fiber: { name: 'Cloth (from Fiber)' },
    weave_cloth_rags: { name: 'Cloth (from Rags)' },
  },
  /** Structures, as they appear in the build list. */
  structures: {
    anvil: {
      name: 'Anvil',
      description:
        'Iron on a stump. Where tools stop being lashed together and start being forged.',
    },
    barricade_wood: {
      name: 'Wood Barricade',
      description: 'Planks nailed across an opening. Fast, ugly, and it buys a night.',
    },
    bear_trap: {
      name: 'Bear Trap',
      description: 'Sprung steel jaws. Holds one thing in place for a long time.',
    },
    bed_bedroll: {
      name: 'Bedroll',
      description: 'Cloth over a fibre mat. You will wake up sore, but you will wake up.',
    },
    bed_wood: {
      name: 'Wood Bed',
      description: 'Frame, slats and a real mattress. Sleeping through the night, properly.',
    },
    campfire: {
      name: 'Campfire',
      description:
        'Light, heat, cooked food and clean water. Nothing else does four jobs this well.',
    },
    chemistry_bench: {
      name: 'Chemistry Bench',
      description: 'Retort, burner and a lot of careful notes. Medicine, powder and spirits.',
    },
    compost_bin: {
      name: 'Compost Bin',
      description: 'Slatted box for scraps and rot. Feed it the harvest you cannot eat.',
    },
    cooking_pot: {
      name: 'Cooking Pot',
      description: 'Iron pot on a tripod. Soup, stew and four bottles of water at a time.',
    },
    door_metal: {
      name: 'Metal Door',
      description: 'Steel slab in a steel frame, keyed. The last door you will need to build.',
    },
    door_reinforced: {
      name: 'Reinforced Door',
      description: 'Scrap plate bolted over planks, and a bar you can drop.',
    },
    door_wood: {
      name: 'Wood Door',
      description: 'A plank door on rope hinges. It closes, which is most of the job.',
    },
    farm_plot: {
      name: 'Farm Plot',
      description: 'Edged, dug and raked. One crop at a time, and it needs watering.',
    },
    fence_barbed: {
      name: 'Barbed Fence',
      description: 'Wire strung between stakes. They walk into it and keep walking into it.',
    },
    fence_wood: {
      name: 'Wood Fence',
      description: 'Waist-high palings. Slows a walker, stops a rabbit.',
    },
    floor_stone: {
      name: 'Stone Floor',
      description: 'Flagstones. Silent underfoot, which matters more than it sounds.',
    },
    floor_wood: {
      name: 'Wood Floor',
      description: 'Planks over the frame. Keeps the mud out and the noise up.',
    },
    foundation_stone: {
      name: 'Stone Foundation',
      description: 'Dressed block bedded in clay. Slow, heavy, and it does not rot.',
    },
    foundation_wood: {
      name: 'Wood Foundation',
      description: 'Logs laid and levelled. Everything else needs something to sit on.',
    },
    furnace: {
      name: 'Furnace',
      description: 'Block and clay around a fire hot enough to free iron from rock.',
    },
    gate_metal: {
      name: 'Metal Gate',
      description: 'A driveway gate cut down and re-hung. Heavy enough to lean on.',
    },
    gate_wood: {
      name: 'Wood Gate',
      description: 'A gap you control. Every wall needs exactly one.',
    },
    grindstone: {
      name: 'Grindstone',
      description: 'A wheel on a crank. Flour, bone meal, and an edge back on a tired blade.',
    },
    hatch: {
      name: 'Hatch',
      description: 'A trapdoor in the floor, barred from the far side.',
    },
    ladder: {
      name: 'Ladder',
      description: 'Two rails and eight rungs. Cheaper than stairs, and it can be pulled up.',
    },
    lantern_post: {
      name: 'Lantern Post',
      description: 'A lantern on a stake. Brighter than a torch and it lasts three nights.',
    },
    loom: {
      name: 'Loom',
      description: 'Warp, weft and a beater. Turns a pile of grass into clothing.',
    },
    planter_box: {
      name: 'Planter Box',
      description: 'Raised, composted and it holds water. Grows faster and dries out slower.',
    },
    sandbag: {
      name: 'Sandbag Wall',
      description: 'Cloth and sand, stacked. Soaks up bullets better than anything you can build.',
    },
    sign: {
      name: 'Sign',
      description: 'A board and a burnt-in message. The cheapest coordination tool in multiplayer.',
    },
    spike_trap: {
      name: 'Spike Trap',
      description:
        'Fire-hardened stakes in a shallow pit. Silent, cheap, and it does not reset itself.',
    },
    stairs_stone: {
      name: 'Stone Stairs',
      description: 'Cut steps. Nothing burns them down.',
    },
    stairs_wood: {
      name: 'Wood Stairs',
      description: 'Six treads and a stringer. Gets you onto the roof.',
    },
    storage_box: {
      name: 'Storage Box',
      description: 'Twenty slots of somewhere-else-to-put-it.',
    },
    storage_crate: {
      name: 'Storage Crate',
      description: 'A proper braced crate. Thirty slots, built in place.',
    },
    storage_locker: {
      name: 'Steel Locker',
      description: 'Sheet steel and a hasp. Forty slots that survive a fire.',
    },
    torch_wall: {
      name: 'Wall Torch',
      description: 'A torch driven into a wall. Burns most of a night.',
    },
    wall_metal: {
      name: 'Metal Wall',
      description: 'Plate over a welded frame. Brutes bounce off it and that is the point.',
    },
    wall_stone: {
      name: 'Stone Wall',
      description: 'Coursed block. Three times the wall for four times the work.',
    },
    wall_wood: {
      name: 'Wood Wall',
      description: 'Planked both sides. The standard early wall, and it will not last the month.',
    },
    wall_wood_frame: {
      name: 'Wood Frame Wall',
      description: 'Sticks lashed into a lattice. It blocks a walker and nothing else.',
    },
    watchtower: {
      name: 'Watchtower',
      description: 'Four legs and a platform. See the horde while it is still a rumour.',
    },
    water_barrel: {
      name: 'Water Barrel',
      description: 'Catches rain and holds it. Stops the daily walk to the pond.',
    },
    well: {
      name: 'Well',
      description: 'Dug, lined and roped. Clean water forever, for two days of digging.',
    },
    window_barred: {
      name: 'Barred Window',
      description: 'Reinforcing bar welded across the opening. Light in, arms out.',
    },
    window_wood: {
      name: 'Window',
      description: 'Glass in a frame. You can see them coming, and they can see you.',
    },
    workbench: {
      name: 'Workbench',
      description: 'A flat surface and a vice. The single biggest jump in what you can make.',
    },
  },
  /** Resource nodes, as named on the focus label and in tooltips. */
  nodes: {
    bush_berry: { name: 'Berry Bush' },
    bush_thorn: { name: 'Thorn Bush' },
    car_wreck: { name: 'Car Wreck' },
    clay_deposit: { name: 'Clay Deposit' },
    fallen_log: { name: 'Fallen Log' },
    fishing_spot: { name: 'Fishing Spot' },
    herb_patch: { name: 'Herb Patch' },
    mushroom_patch: { name: 'Mushroom Patch' },
    ore_coal: { name: 'Coal Seam' },
    ore_copper: { name: 'Copper Vein' },
    ore_iron: { name: 'Iron Vein' },
    plant_fiber_patch: { name: 'Fiber Grass' },
    rock_boulder: { name: 'Boulder' },
    rock_small: { name: 'Loose Rock' },
    sand_deposit: { name: 'Sand Pit' },
    scrap_pile: { name: 'Scrap Pile' },
    stump: { name: 'Tree Stump' },
    tree_birch: { name: 'Birch' },
    tree_dead: { name: 'Dead Tree' },
    tree_oak: { name: 'Oak' },
    tree_pine: { name: 'Pine' },
    water_source: { name: 'Water' },
  },
  /** The infected. */
  zombies: {
    armored: { name: 'Armored Zombie' },
    bloater: { name: 'Bloater' },
    brute: { name: 'Brute' },
    crawler: { name: 'Crawler' },
    feral_dog_zombie: { name: 'Feral Dog' },
    runner: { name: 'Runner' },
    screamer: { name: 'Screamer' },
    shambler: { name: 'Shambler' },
    spitter: { name: 'Spitter' },
    walker: { name: 'Walker' },
  },
  /** Wildlife. */
  animals: {
    bear: { name: 'Bear' },
    boar: { name: 'Boar' },
    chicken: { name: 'Chicken' },
    cow: { name: 'Cow' },
    deer: { name: 'Deer' },
    fox: { name: 'Fox' },
    rabbit: { name: 'Rabbit' },
    wolf: { name: 'Wolf' },
  },
  /** Crops, as named on a farm plot. */
  crops: {
    beans: { name: 'Beans' },
    cabbage: { name: 'Cabbage' },
    carrot: { name: 'Carrot' },
    corn: { name: 'Corn' },
    herb: { name: 'Medicinal Herb' },
    onion: { name: 'Onion' },
    potato: { name: 'Potato' },
    pumpkin: { name: 'Pumpkin' },
    tomato: { name: 'Tomato' },
    wheat: { name: 'Wheat' },
  },
};
