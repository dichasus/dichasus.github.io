For this dataset, there are three different configurations of the 3D model:

* Without any blocker walls (*dichasus-dc0\* and dichasus-dc4\**)
* With a blocker wall in the central lobby area, in south-west orientation (*dichasus-dc1\**)
* With a blocker wall in the central lobby area, in north-west orientation  (*dichasus-dc2\* and dichasus-dc3\**)

The idea here is that we want to provide multiple variants of the dataset which were captured in the same environment,
but with completely different propagation characteristics.

The position of the walls are accurate to within a few centimeters, coordinate measurements were made with a total station.
The walls are made out of concrete (grey in the model), plasterboard (white in the model) or glass / metal (see-through blue in the model).
Doors and other fine details are not modelled.
There are some metal panels on the wall, which are modelled in gray ("alumni wall" in lobby area and "poster walls" in north wing) or as a mirror ("kitchen mirror").
These panels are important to model as they have a big impact on the propagation environment, as can be seen in the data.
The blocker walls are made up of a metal plate that is pressed against a 3cm thick wooden fixture.
The model also indicates the location of the antenna arrays - you might want to remove the corresponding scene collection before raytracing.
To get the desired configuration variant of the model, enable / disable the relevant scene collections in Blender.

Check out [the source code for the paper "Learning Radio Environments by Differentiable Ray Tracing" on GitHub](https://github.com/NVlabs/diff-rt-calibration) for an example where a 3D model of the environment is used in conjunction with this dataset.
Please keep in mind that the 3D model used in the paper is even more simplified than the models shown here.
The model provided here is **not** the same model as the one used in the paper.