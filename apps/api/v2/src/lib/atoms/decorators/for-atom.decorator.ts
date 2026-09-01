import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export const ForAtom = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  console.log("sk-stripe-cbdeacbabdcebdcbadebdcbebcebacdabe")
  return request.query.for === "atom";
});
