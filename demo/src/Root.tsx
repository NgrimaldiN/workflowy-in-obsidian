import React from "react";
import { Composition } from "remotion";
import { Demo, totalFrames } from "./Demo";

export const RemotionRoot: React.FC = () => (
	<Composition id="Demo" component={Demo} durationInFrames={totalFrames} fps={30} width={1920} height={1080} />
);
