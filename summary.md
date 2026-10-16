# Data Annotator
This is a data annotator for maps and satellite views. It will be used for model training in the future. 

It is based on OpenStreetMap data, but we want to create more rich features based on a satellite imagery background. 
First, along existing road slices, I'd like to mark what a "road slice" is, which is continuous strip of road between intersections, up to a maximum length of 5m. This will have two "end" nodes, shared with the two slices on either side in the case of a continuous strip, or with multiple slices in the case of an intersection.

Human annotation and ML process
1. Select an OSM segment, it has n nodes.
2. Move the "first" node to its correct position, aligned with the middle of the road on the satellite imagery. The middle of the intersection if applicable. (Model A)
    This previous step actually moves the whole OSM segment, all nodes, but only the first node is in alignment now.
3. Move the last node to the last position in the middle of the road on the satellite imagery. (Model A)
4. Moving from the first node, create a new node along the OSM segments at 5m from the first node. Move this first node to align with the middle of the road (model B). If we cross an OSM node whilst moving along the segment, discard this node. Move every "further" OSM node a little bit in the direction you moved this node in, with some kind of decay factor.
5. Move another 5m along the OSM segment, repeat step 4. Do this until going 5m pushes you past the last node. Keep the last OSM node and stop.

The end result is that we'd like to train a model to generate these strips 