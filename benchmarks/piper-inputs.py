import json
import sys

from piper.phoneme_ids import phonemes_to_ids
from piper.phonemize_espeak import EspeakPhonemizer

config = json.load(open(sys.argv[1], encoding="utf-8"))
sentences = EspeakPhonemizer().phonemize(config["espeak"]["voice"], sys.argv[2])
print(json.dumps([phonemes_to_ids(x, config["phoneme_id_map"]) for x in sentences]))
