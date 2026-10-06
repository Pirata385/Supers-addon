#!/usr/bin/env python3
"""Generate the add-on's .mcstructure files, world-generation features and chest loot.

Outputs (behavior pack):
  structures/sp/mutagen_lab.mcstructure   -> structure id "sp:mutagen_lab"
  structures/sp/meteor_crash.mcstructure  -> structure id "sp:meteor_crash"
  features/sp_mutagen_lab_feature.json, features/sp_meteor_crash_feature.json
  feature_rules/sp_mutagen_lab_rule.json, feature_rules/sp_meteor_crash_rule.json
  loot_tables/chests/sp_mutagen_lab.json

Deterministic: running it twice produces identical files.
"""
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nbt  # noqa: E402

BP = os.path.join(os.path.dirname(HERE), 'packs', 'SuperpowersBP')
# block palette version tag (1.21.130 era; the game upgrades older palettes automatically)
BLOCK_VERSION = (1 << 24) | (21 << 16) | (130 << 8)


class Template:
    def __init__(self, sx, sy, sz, fill='minecraft:structure_void'):
        self.size = (sx, sy, sz)
        self.blocks = {}
        self.default = fill
        self.block_entities = {}

    def set(self, x, y, z, name, states=None, block_entity=None):
        sx, sy, sz = self.size
        if not (0 <= x < sx and 0 <= y < sy and 0 <= z < sz):
            return
        self.blocks[(x, y, z)] = (name, tuple(sorted((states or {}).items())))
        if block_entity is not None:
            self.block_entities[(x, y, z)] = block_entity
        else:
            self.block_entities.pop((x, y, z), None)

    def get(self, x, y, z):
        return self.blocks.get((x, y, z), (self.default, ()))[0]

    def box(self, x0, y0, z0, x1, y1, z1, name, states=None):
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                for z in range(z0, z1 + 1):
                    self.set(x, y, z, name, states)

    def to_nbt(self):
        sx, sy, sz = self.size
        palette = []
        index = {}
        layer = []
        positions = {}
        for x in range(sx):
            for y in range(sy):
                for z in range(sz):
                    key = self.blocks.get((x, y, z), (self.default, ()))
                    if key not in index:
                        index[key] = len(palette)
                        palette.append(key)
                    i = len(layer)
                    layer.append(index[key])
                    if (x, y, z) in self.block_entities:
                        positions[i] = self.block_entities[(x, y, z)]
        waterlog = [-1] * len(layer)

        def state_tag(v):
            if isinstance(v, bool):
                return nbt.byte(1 if v else 0)
            if isinstance(v, int):
                return nbt.int_(v)
            return nbt.string(v)

        block_palette = []
        for name, states in palette:
            block_palette.append({
                'name': nbt.string(name),
                'states': nbt.compound({k: state_tag(v) for k, v in states}),
                'version': nbt.int_(BLOCK_VERSION),
            })
        pos_data = {str(i): nbt.compound({'block_entity_data': nbt.compound(be)}) for i, be in positions.items()}
        root = nbt.compound({
            'format_version': nbt.int_(1),
            'size': nbt.list_(nbt.TAG_INT, list(self.size)),
            'structure': nbt.compound({
                'block_indices': nbt.list_(nbt.TAG_LIST, [(nbt.TAG_INT, layer), (nbt.TAG_INT, waterlog)]),
                'entities': nbt.list_(nbt.TAG_COMPOUND, []),
                'palette': nbt.compound({
                    'default': nbt.compound({
                        'block_palette': nbt.list_(nbt.TAG_COMPOUND, block_palette),
                        'block_position_data': nbt.compound(pos_data),
                    }),
                }),
            }),
            'structure_world_origin': nbt.list_(nbt.TAG_INT, [0, 0, 0]),
        })
        return nbt.dumps('', root)


def chest_entity(x, y, z, loot):
    return {
        'id': nbt.string('Chest'),
        'isMovable': nbt.byte(1),
        'Findable': nbt.byte(0),
        'LootTable': nbt.string(loot),
        'LootTableSeed': nbt.int_(0),
        'Items': nbt.list_(nbt.TAG_COMPOUND, []),
        'x': nbt.int_(x), 'y': nbt.int_(y), 'z': nbt.int_(z),
    }


def build_lab():
    """11 x 7 x 11 bunker: deepslate frame, tinted windows, mutagen tanks, loot chest."""
    rnd = random.Random(1337)
    W, H, D = 11, 7, 11
    t = Template(W, H, D, fill='minecraft:air')
    # foundation (y=0) and floor
    t.box(0, 0, 0, W - 1, 0, D - 1, 'minecraft:polished_deepslate')
    t.box(1, 0, 1, W - 2, 0, D - 2, 'minecraft:smooth_stone')
    # walls y=1..4
    for y in range(1, 5):
        for x in range(W):
            for z in range(D):
                edge = x in (0, W - 1) or z in (0, D - 1)
                if not edge:
                    continue
                corner = x in (0, W - 1) and z in (0, D - 1)
                if corner or (x in (0, W - 1) and z == D // 2) or (z in (0, D - 1) and x == W // 2 and z != 0):
                    t.set(x, y, z, 'minecraft:polished_deepslate')
                else:
                    t.set(x, y, z, 'minecraft:stone_bricks' if rnd.random() > 0.18 else 'minecraft:cracked_stone_bricks')
    # windows
    for x in (2, 3, 7, 8):
        for y in (2, 3):
            t.set(x, y, D - 1, 'minecraft:tinted_glass')
    for z in (2, 3, 7, 8):
        for y in (2, 3):
            t.set(0, y, z, 'minecraft:tinted_glass')
            t.set(W - 1, y, z, 'minecraft:tinted_glass')
    # doorway (south, z=0)
    for y in (1, 2):
        t.set(W // 2, y, 0, 'minecraft:air')
    t.set(W // 2, 3, 0, 'minecraft:polished_deepslate')
    # roof y=5 and parapet y=6
    t.box(0, 5, 0, W - 1, 5, D - 1, 'minecraft:polished_deepslate')
    t.box(1, 5, 1, W - 2, 5, D - 2, 'minecraft:smooth_stone')
    for (x, z) in ((3, 3), (7, 3), (3, 7), (7, 7), (5, 5)):
        t.set(x, 5, z, 'minecraft:sea_lantern')
    for x in range(W):
        for z in range(D):
            if x in (0, W - 1) or z in (0, D - 1):
                t.set(x, 6, z, 'minecraft:polished_deepslate' if (x + z) % 2 == 0 else 'minecraft:air')
            else:
                t.set(x, 6, z, 'minecraft:air')
    # interior: tanks along the north wall, specimen table, workbench, loot chest
    for x in (2, 4, 6, 8):
        t.set(x, 1, D - 2, 'sp:mutagen_tank')
        t.set(x, 2, D - 2, 'sp:mutagen_tank')
    for z in (3, 5, 7):
        t.set(1, 1, z, 'sp:mutagen_tank')
    t.set(5, 1, 5, 'minecraft:white_concrete')
    t.set(5, 1, 6, 'minecraft:white_concrete')
    t.set(W - 2, 1, 2, 'minecraft:crafting_table')
    t.set(W - 2, 1, 3, 'minecraft:smithing_table')
    t.set(W - 3, 1, 1, 'minecraft:redstone_block')
    t.set(W - 3, 2, 1, 'minecraft:redstone_lamp')
    t.set(2, 1, 2, 'minecraft:chest', {'minecraft:cardinal_direction': 'south'},
          chest_entity(2, 1, 2, 'loot_tables/chests/sp_mutagen_lab.json'))
    t.set(3, 1, 2, 'minecraft:chest', {'minecraft:cardinal_direction': 'south'},
          chest_entity(3, 1, 2, 'loot_tables/chests/sp_mutagen_lab.json'))
    # damaged floor: a few scorched tiles
    for _ in range(6):
        x, z = rnd.randint(2, W - 3), rnd.randint(2, D - 3)
        if t.get(x, 1, z) == 'minecraft:air':
            t.set(x, 0, z, 'minecraft:polished_blackstone')
    return t


def build_crater():
    """13 x 9 x 13 bowl crater around a meteorite. Origin is placed 4 blocks below the surface."""
    rnd = random.Random(4242)
    W, H, D = 13, 9, 13
    surface = 4
    cx, cz = 6, 6
    R = 6.2
    t = Template(W, H, D, fill='minecraft:structure_void')
    scorched = ['minecraft:blackstone', 'minecraft:basalt', 'minecraft:coarse_dirt', 'minecraft:magma',
                'minecraft:blackstone', 'minecraft:coarse_dirt', 'minecraft:tuff']
    for x in range(W):
        for z in range(D):
            r = math.hypot(x - cx, z - cz)
            if r > R:
                continue
            depth = 3.2 * (1 - (r / R) ** 2)
            floor_y = int(round(surface - depth))
            # carve air above the bowl surface up to the top of the template
            for y in range(floor_y + 1, H):
                t.set(x, y, z, 'minecraft:air')
            # scorched lining (1-2 blocks)
            for y in range(max(0, floor_y - 1), floor_y + 1):
                name = rnd.choice(scorched)
                states = {'pillar_axis': 'y'} if name == 'minecraft:basalt' else None
                t.set(x, y, z, name, states)
    # meteorite core
    core_floor = int(round(surface - 3.2))
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1):
            if abs(dx) + abs(dz) <= 1 or rnd.random() < 0.5:
                t.set(cx + dx, core_floor, cz + dz, 'sp:meteorite')
    t.set(cx, core_floor + 1, cz, 'sp:meteorite')
    t.set(cx + 1, core_floor + 1, cz, 'sp:meteorite')
    t.set(cx, core_floor + 2, cz, 'sp:meteorite')
    t.set(cx, core_floor - 1, cz, 'minecraft:magma')
    # scattered fragments on the slopes
    for _ in range(7):
        a = rnd.random() * math.pi * 2
        r = rnd.uniform(2.2, 4.8)
        x, z = int(round(cx + math.cos(a) * r)), int(round(cz + math.sin(a) * r))
        depth = 3.2 * (1 - (min(r, R) / R) ** 2)
        y = int(round(surface - depth))
        t.set(x, y, z, 'sp:meteorite' if rnd.random() < 0.6 else 'minecraft:magma')
    return t


def write(path, data, binary=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if binary:
        open(path, 'wb').write(data)
    else:
        open(path, 'w').write(json.dumps(data, indent=2) + '\n')


def main():
    write(os.path.join(BP, 'structures', 'sp', 'mutagen_lab.mcstructure'), build_lab().to_nbt(), True)
    write(os.path.join(BP, 'structures', 'sp', 'meteor_crash.mcstructure'), build_crater().to_nbt(), True)

    land_biomes = {'all_of': [
        {'test': 'has_biome_tag', 'operator': '==', 'value': 'overworld'},
        {'test': 'has_biome_tag', 'operator': '!=', 'value': 'ocean'},
        {'test': 'has_biome_tag', 'operator': '!=', 'value': 'river'},
        {'test': 'has_biome_tag', 'operator': '!=', 'value': 'beach'},
        {'test': 'has_biome_tag', 'operator': '!=', 'value': 'swamp'},
    ]}
    for name, struct, chance, yexpr, constraints in (
        ('mutagen_lab', 'sp:mutagen_lab', 520, 'query.heightmap(variable.worldx, variable.worldz)',
         {'grounded': {}, 'unburied': {}, 'block_intersection': {'block_allowlist': [
             'minecraft:air', 'minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:fern', 'minecraft:large_fern',
             'minecraft:snow_layer', 'minecraft:dandelion', 'minecraft:poppy', 'minecraft:deadbush']}}),
        ('meteor_crash', 'sp:meteor_crash', 260, 'query.heightmap(variable.worldx, variable.worldz) - 4',
         {'block_intersection': {'block_allowlist': ['minecraft:air', 'minecraft:grass_block', 'minecraft:dirt',
                                                     'minecraft:stone', 'minecraft:sand', 'minecraft:gravel',
                                                     'minecraft:short_grass', 'minecraft:tall_grass', 'minecraft:snow_layer',
                                                     'minecraft:coarse_dirt', 'minecraft:podzol', 'minecraft:red_sand',
                                                     'minecraft:sandstone', 'minecraft:terracotta', 'minecraft:andesite',
                                                     'minecraft:granite', 'minecraft:diorite', 'minecraft:deepslate',
                                                     'minecraft:tuff', 'minecraft:clay', 'minecraft:snow']}}),
    ):
        write(os.path.join(BP, 'features', f'sp_{name}_feature.json'), {
            'format_version': '1.13.0',
            'minecraft:structure_template_feature': {
                'description': {'identifier': f'sp:{name}_feature'},
                'structure_name': struct,
                'adjustment_radius': 4,
                'facing_direction': 'random',
                'constraints': constraints,
            },
        })
        write(os.path.join(BP, 'feature_rules', f'sp_{name}_rule.json'), {
            'format_version': '1.13.0',
            'minecraft:feature_rules': {
                'description': {'identifier': f'sp:{name}_rule', 'places_feature': f'sp:{name}_feature'},
                'conditions': {'placement_pass': 'surface_pass', 'minecraft:biome_filter': land_biomes},
                'distribution': {
                    'iterations': 1,
                    'scatter_chance': {'numerator': 1, 'denominator': chance},
                    'x': {'distribution': 'uniform', 'extent': [0, 15]},
                    'y': yexpr,
                    'z': {'distribution': 'uniform', 'extent': [0, 15]},
                },
            },
        })

    write(os.path.join(BP, 'loot_tables', 'chests', 'sp_mutagen_lab.json'), {
        'pools': [
            {'rolls': {'min': 1, 'max': 2}, 'entries': [
                {'type': 'item', 'name': f'sp:syringe_{p}', 'weight': 3}
                for p in ('strength', 'flight', 'heat_vision', 'speedster', 'esper')
            ] + [
                {'type': 'item', 'name': 'sp:syringe_unstable', 'weight': 4},
                {'type': 'item', 'name': 'sp:suppressor_serum', 'weight': 3},
                {'type': 'empty', 'weight': 12},
            ]},
            {'rolls': {'min': 2, 'max': 4}, 'entries': [
                {'type': 'item', 'name': 'sp:mutagen_crystal', 'weight': 10,
                 'functions': [{'function': 'set_count', 'count': {'min': 1, 'max': 4}}]},
                {'type': 'item', 'name': 'sp:syringe_empty', 'weight': 8,
                 'functions': [{'function': 'set_count', 'count': {'min': 1, 'max': 3}}]},
                {'type': 'item', 'name': 'minecraft:iron_ingot', 'weight': 6,
                 'functions': [{'function': 'set_count', 'count': {'min': 1, 'max': 5}}]},
                {'type': 'item', 'name': 'minecraft:glass_bottle', 'weight': 5,
                 'functions': [{'function': 'set_count', 'count': {'min': 1, 'max': 3}}]},
                {'type': 'item', 'name': 'minecraft:redstone', 'weight': 5,
                 'functions': [{'function': 'set_count', 'count': {'min': 2, 'max': 8}}]},
                {'type': 'item', 'name': 'minecraft:glowstone_dust', 'weight': 4,
                 'functions': [{'function': 'set_count', 'count': {'min': 1, 'max': 4}}]},
                {'type': 'item', 'name': 'minecraft:experience_bottle', 'weight': 3,
                 'functions': [{'function': 'set_count', 'count': {'min': 1, 'max': 3}}]},
            ]},
            {'rolls': 1, 'entries': [
                {'type': 'item', 'name': 'sp:mutant_codex', 'weight': 1},
                {'type': 'empty', 'weight': 3},
            ]},
        ],
    })
    print('structures, features and loot written')


if __name__ == '__main__':
    main()
