function box<T>(initial: T) {
  return { value: initial };
}

let source = 1;
const observed = () => source;
const total = box(0);

total.value = observed() + 2;
console.log(`first:${total.value}`);

source = 5;
total.value += observed();
total.value++;
console.log(`second:${total.value}`);
