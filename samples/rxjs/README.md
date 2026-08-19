# RxJS sample

This sample uses the unmodified published `rxjs` 7.8.2 package. It exercises
the package's re-export graph, `Observable.pipe` overload selection,
higher-order generic operator functions, contextual callback parameters, and
the promise returned by `lastValueFrom`.

The deterministic pipeline filters numbers, maps them into typed objects,
accumulates one of their properties, and maps the final total into a string.
