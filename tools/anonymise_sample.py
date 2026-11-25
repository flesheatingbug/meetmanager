"""Replace athlete names in a sample meet file with made-up ones.

Keeps numbers, clubs, categories and results, so scoring is unchanged.
Usage: python tools/anonymise_sample.py in.json out.json
"""
import hashlib
import json
import sys

GIRLS = ("Aoife Ciara Saoirse Niamh Caoimhe Roisin Grace Emma Sophie Ella Lucy Ava Kate Chloe Amy Sarah "
         "Hannah Leah Molly Clodagh Orla Eabha Aisling Sinead Laura Rachel Megan Isabel Zoe Freya Lily Mia "
         "Eve Holly Anna Ruby Erin Fiadh Sadhbh Meabh").split()
BOYS = ("Jack Sean Conor Cian Oisin Darragh Fionn Liam Adam Luke James Daniel Ryan Tadhg Eoin Rory Cillian "
        "Patrick Michael Aaron Ben Callum Dylan Evan Finn Harry Josh Kevin Noah Ronan Shane Thomas Colm "
        "Donal Diarmuid Niall Brian Mark Paul Dara").split()
SURNAMES = ("MURPHY KELLY SULLIVAN WALSH SMITH BYRNE RYAN CONNOR NEILL REILLY DOYLE MCCARTHY GALLAGHER "
            "DOHERTY KENNEDY LYNCH MURRAY QUINN MOORE MCLOUGHLIN CARROLL CONNOLLY DALY CONNELL WILSON DUNNE "
            "BRENNAN BURKE COLLINS CAMPBELL CLARKE JOHNSTON HUGHES FARRELL FITZGERALD BROWN MARTIN MAGUIRE "
            "NOLAN FLYNN THOMPSON CALLAGHAN DONNELL DUFFY MAHONY BOYLE HEALY SHEA WHITE SWEENEY HAYES "
            "KAVANAGH POWER MCGRATH MORAN BRADY STEWART CASEY FOLEY FITZPATRICK LEARY MCDONNELL DONNELLY "
            "REGAN DONOVAN BURNS FLANAGAN MULLAN BARRY KANE ROBINSON CUNNINGHAM GRIFFIN KENNY SHEEHAN WARD "
            "WHELAN LYONS REID GRAHAM HIGGINS CULLEN KEANE KING MAHER MCKENNA BELL SCOTT HOGAN KEEFFE MAGEE "
            "MCNAMARA MCDONALD HURLEY").split()


def pick(options, key):
    return options[int(hashlib.sha1(key.encode()).hexdigest(), 16) % len(options)]


def main(src, dst):
    meet = json.load(open(src, encoding='utf-8'))
    used = {e['name'].upper() for e in meet['entries']}  # never reuse a real name
    for e in meet['entries']:
        female = any(w in e['category'] for w in ('Girls', 'Women', 'Ladies'))
        key = str(e['id'])
        for salt in range(100):
            name = pick(GIRLS if female else BOYS, f'{key}f{salt}') + ' ' + pick(SURNAMES, f'{key}s{salt}')
            if name.upper() not in used:
                break
        used.add(name.upper())
        e['name'], e['dob'], e['reg'] = name, '', ''
    meet['settings']['title'] = 'Example meet (made-up names)'
    json.dump(meet, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('anonymised', len(meet['entries']), 'athletes')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
