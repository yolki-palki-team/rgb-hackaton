MATERIAL

Everything is in the shared folder:https://drive.google.com/drive/folders/1HqZP4TDRmsvYW6hsW7T6-OoNNZMVFV-X?usp=drive_link  .

What you find there:

-Two videos on RGB, high level, to understand what the protocol does
before you touch any code.

-A QVAC tutorial.

-A WDK tutorial.

-A video walkthrough of the KaleidoSwap builder kit, made for you guys, for this hackathon to make life simpler for anyone who has never touched RGB before.
https://kaleidoswap.github.io/rgb-hackathon/

-An Excel file with every link you might need, sorted by whether you
need it to start, to study, or to go deep.



THE STACK

RGB Protocol on Bitcoin. Mandatory. The asset layer. Source of thruth for the concepts:
https://docs.rgb.info/

QVAC. Mandatory. The local AI layer, running on device.
https://docs.qvac.tether.io/quickstart/

WDK. Optional, earns bonus points. Self-custodial wallets.
https://docs.wdk.tether.io/

Read the concepts. Nothing replaces understanding how a transfer
actually works.



RGB ASSISTANT

We trained a GPT on the RGB documentation, so you can ask it things
instead of digging through the docs.

https://chatgpt.com/g/g-69f31db8cae081918db75cbd969df294-rgb-protocol-on-bitcoin-assistant

You do not need ChatGPT Plus, a free account is enough, you just have
to be logged in.

Very cool to speed your study while your are checking the docs. Use it to get oriented fast: what something is, where to look, which
library does what. For anything you are about to build on.



WHICH WAY IN

1) If you have never used RGB before, do not start from the protocol
repos. Use the KaleidoSwap builder kit, or UTEXO's forks and SDKs.
Both exist so that you do not have to assemble the stack yourself:
you get a node, wallets you can build on top of, and in KaleidoSwap's
case tools that already run on QVAC, so a user writes in plain language
and an RGB invoice gets generated. UTEXO also has an adapter that
connects WDK to RGB, and a React Native library if you are going
mobile. Mentors from both are in the room all weekend.

2) If you already know your way around: rgb-lib for on-chain transactions,
and RGB Lightning Node if you want RGB assets over Lightning. More
control, more work. Some people alerady told use they explored RGB-Tools on github and played around with RLN, your choice.

Either way, we recommend you to pick your path at the start and do not switch halfway.