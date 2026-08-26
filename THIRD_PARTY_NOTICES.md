# Third-party notices

My LOOI uses third-party open-source software and model assets. Their original licenses remain applicable.

## Upstream project

Portions of My LOOI originated from the MIT-licensed `GrinZero/super-looi` project. The historical MIT notice that accompanied the upstream source is preserved in `licenses/UPSTREAM_EXPO_MIT_NOTICE.txt`.

## Vosk command models

Android release builds download and bundle selected Vosk command models from the official Vosk model catalog. The selected models used by the build script are listed by Vosk as Apache License 2.0 models. A copy of Apache License 2.0 is included in `licenses/APACHE-2.0.txt`.

Source: https://alphacephei.com/vosk/models

## Silero VAD

The repository includes a Silero VAD ONNX model under `assets/models/sherpa-onnx/vad/`. Silero VAD is distributed under the MIT License; its notice is preserved in `licenses/SILERO-VAD-MIT.txt`.

Source: https://github.com/snakers4/silero-vad

## sherpa-onnx

The project uses sherpa-onnx-based runtime components. The sherpa-onnx source project is licensed under Apache License 2.0; a copy is included in `licenses/APACHE-2.0.txt`.

Source: https://github.com/k2-fsa/sherpa-onnx

Some optional speech/speaker model files are downloaded from upstream model releases rather than committed to this repository. Model weights can have license terms distinct from the inference runtime; verify the license of any additional model before redistributing it.

## OpenAI

OpenAI model weights are not distributed with My LOOI. Realtime models and voices are accessed through the OpenAI API using the user's own API key and are subject to OpenAI's applicable terms and pricing.

## JavaScript and Android dependencies

The application also includes packages resolved through pnpm, Expo/React Native autolinking, and Gradle. Each dependency remains subject to its own license. A final public APK should receive a binary/license inventory audit before release.
