# Changelog

## 0.3.5
- New languages: Chinese (Simplified), French, German, Italian, Japanese, Korean, Polish, Portuguese (Brazil), Russian,
  Spanish, Ukrainian.
- Regions cut walls: a region that is switched off cuts nothing — its «Disable region» box, or a bound tile that is
  hidden. Hide the bridge and the wagon's wall is back. «Disable region» and «Tile binding» now also show for a
  wall-cutting region without a type.
- Tile scroll: a «Motion» checkbox. Untick it to freeze the background where it is; tick it again and it moves on from
  the same spot, without a jump.

## 0.3.4
- Regions cut walls: a «Cut walls» checkbox in the region config. A wall whose middle lies in such a region, whose
  height falls in its elevation range and which is not linked to it by Mass Edit is switched off entirely — as if it
  were not there — while the region covers it, and comes back as it was when the region is moved or deleted. Made for
  bridges between wagons: regions at the bridge's ends, linked to the bridge, open the wagons' walls where it meets them.

## 0.3.3
- Shared video for identical tiles: video tiles with the same file draw one shared video instead of a copy each, so
  the file is decoded once for all of them — webm with transparency is decoded on the CPU, and the load used to grow
  with every copy. The copies play in sync; pause, seek and volume of one act on all of them. Not shared: files also
  used by tokens, and tiles with pauses between showings or a clip pool. On by default; toggling it takes a reload.

## 0.3.2
- Partial tile fade: a wall whose top is below the token's eyes now counts as an opening. A token above it — say, on a
  bridge that enters a tower over the gate — sees into the room under the roof.
- Tokens standing on a faded tile now fade out on tiles with plain «Fade» too (a bridge, a balcony): hovered from
  below, the tile no longer leaves them hanging in the air. Same setting as for partial fade, renamed «Fade: hide
  tokens on a faded roof».

## 0.3.1
- Update notice: when a newer ADMaps Tools release is out, the GM gets a window with both versions and how to update.
  «Don't show again» hides it until the next release; the tool can be turned off in the module settings.

## 0.3.0
- The author link now points to [admaps.cloud](https://admaps.cloud/).

## 0.2.9
- First public release.
- Worlds on other game systems: Alt+W no longer throws an error on scenes with regions, and three floor tools no longer
  log a 404 in the console.

## 0.2.8
- A token dropped while a Levels floor is selected falls to the floor below when that floor has nothing at the drop
  point; bare ground counts as a floor at 0.
- Partial tile fade: a token that walks in to stop under a roof fades it at once; a token passing under the roof or
  brushing its edge no longer blacks it out.

## 0.2.7
- Import scenes from folder: scenes are created inactive. In a world without an active scene the first imported scene
  used to come out black.

## 0.2.6
- Scene variations: switching with the Levels floor panel open no longer rewrites elevations, teleports keep working
  after a switch, and the selected floor is restored after the redraw.
- Quick keyboard movement on stairs no longer drops a token through the floor.

## 0.2.5
- A token dropped while a Levels floor is selected lands on that floor at the drop point, and the floor panel switches
  to the token's floor.

## 0.2.4
- Faster floor lookups for elevation regions.
- Partial tile fade tool.
