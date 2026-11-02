| Condition | Repeats with a hit | Mean cached on repeat | Cached tokens per pair | Cold first calls |
| --- | --- | --- | --- | --- |
| plain text, repeated | 4 of 4 | 83% | 16352, 16352, 16352, 16352 | 4 of 4 |
| same responseSchema, repeated | 4 of 4 | 82% | 16266, 16266, 16266, 16266 | 4 of 4 |
| different responseSchema on the repeat | 0 of 4 | 0% | 0, 0, 0, 0 | 4 of 4 |
| same tools, repeated | 3 of 4 | 62% | 16313, 16313, 0, 16313 | 4 of 4 |
| tools, then restricted to one function | 0 of 4 | 0% | 0, 0, 0, 0 | 4 of 4 |
