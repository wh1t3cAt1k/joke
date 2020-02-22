import { pipe } from "fp-ts/lib/pipeable";
import * as A from "fp-ts/lib/Array";
import * as O from "fp-ts/lib/Option";
import { addNamed, addNamespace } from "@babel/helper-module-imports";
import { PluginObj } from "@babel/core";
import { Binding, NodePath } from "@babel/traverse";
import { Program } from "@babel/types";

const MODULE_NAME = "@userlike/joke";
const IMPORT_FN = "mock";
const GLOBAL_JEST = "jest";
const GLOBAL_JEST_FN = "mock";

export default function UserlikeJoke({
  types: t
}: typeof import("@babel/core")): PluginObj {
  return {
    name: "@userlike/babel-plugin-joke",
    visitor: {
      Program(path): void {
        const statements = path.node.body;
        const namedMockRefs = statements
          .filter(pred(t.isImportDeclaration))
          .filter(s => s.source.value === MODULE_NAME)
          .flatMap(s => s.specifiers)
          .filter(pred(t.isImportSpecifier))
          .filter(s => s.imported.name === IMPORT_FN)
          .map(s => s.local.name)
          .map(ref => path.scope.getBinding(ref))
          .filter((ref): ref is Binding => ref !== undefined)
          .flatMap(ref => ref.referencePaths);

        const namespaceMockRefs = statements
          .filter(pred(t.isImportDeclaration))
          .filter(s => s.source.value === MODULE_NAME)
          .flatMap(s => s.specifiers)
          .filter(pred(t.isImportNamespaceSpecifier))
          .map(s => s.local.name)
          .map(ref => path.scope.getBinding(ref))
          .filter((ref): ref is Binding => ref !== undefined)
          .flatMap(ref => ref.referencePaths)
          .filter(path => {
            const M = path.node;
            const memberExpr = path.parent;
            if (!t.isMemberExpression(memberExpr)) return false;
            if (memberExpr.object !== M) return false;
            if (
              !t.isIdentifier(memberExpr.property) ||
              memberExpr.property.name !== "mock"
            )
              return false;
            return true;
          })
          .map(path => path.parentPath);

        const mockRefPaths = namedMockRefs
          .concat(namespaceMockRefs)
          .filter(path => {
            if (path.scope.getProgramParent() !== path.scope) {
              throw new Error("Can only use `mock` at the top-level scope.");
            }
            return true;
          });

        mockRefPaths.forEach(process(t, path));
      }
    }
  };
}

function process(
  t: typeof import("@babel/types"),
  path: NodePath<Program>
): (mockRef: NodePath) => void {
  return (mockPath): void => {
    const callPath = mockPath.parentPath;
    const call = mockPath.parent;

    invariant(t.isCallExpression(call), callPath);

    const asyncImport = call.arguments[0];
    invariant(t.isCallExpression(asyncImport), callPath);
    invariant(t.isImport(asyncImport.callee), callPath);
    invariant(asyncImport.arguments.length === 1, callPath);

    const moduleNameLiteral = asyncImport.arguments[0];
    invariant(t.isStringLiteral(moduleNameLiteral), callPath);
    const moduleName = moduleNameLiteral.value;

    const parentPath = callPath.parentPath;

    invariant(
      t.isVariableDeclarator(parentPath.node) ||
        t.isMemberExpression(parentPath.node),
      parentPath
    );

    if (t.isVariableDeclarator(parentPath.node)) {
      const declaratorPath = parentPath;
      const declarator = parentPath.node;
      invariant(t.isVariableDeclarator(declarator), declaratorPath);

      const lval = declarator.id;

      invariant(
        t.isObjectPattern(lval) || t.isIdentifier(lval),
        declaratorPath
      );

      if (t.isObjectPattern(lval)) {
        const namedImports = lval.properties.map(p => {
          invariant(!t.isRestElement(p), declaratorPath);
          invariant(t.isIdentifier(p.key), declaratorPath);
          invariant(t.isIdentifier(p.value), declaratorPath);
          return [p.key.name, p.value.name];
        });
        namedImports.forEach(([k, v]) => {
          const newName = addNamed(path, k, moduleName, { nameHint: v });
          path.scope.rename(v, newName.name);
        });
      } else {
        const oldName = lval.name;
        const newName = addNamespace(path, moduleName);
        path.scope.rename(oldName, newName.name);
      }
      const declarationPath = declaratorPath.parentPath;
      const declaration = declarationPath.node;
      invariant(t.isVariableDeclaration(declaration), declarationPath);
      const idx = declaration.declarations.findIndex(d => d === declarator);
      declaration.declarations.splice(idx, 1);

      if (declaration.declarations.length === 0) {
        declarationPath.remove();
      }
    } else {
      const memberExpr = parentPath.node;
      const named = memberExpr.property;
      invariant(t.isIdentifier(named), parentPath);
      const newName = addNamed(path, named.name, moduleName);
      parentPath.replaceWith(t.identifier(newName.name));
    }

    const insertJestMockIO = pipe(
      path.get("body"),
      A.findLast(p => t.isImportDeclaration(p.node)),
      O.map(lastImportPath => (): void =>
        lastImportPath.insertAfter(
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(
                t.identifier(GLOBAL_JEST),
                t.identifier(GLOBAL_JEST_FN)
              ),
              [t.stringLiteral(moduleName)]
            )
          )
        )
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      O.getOrElse(() => (): void => {})
    );

    insertJestMockIO();
  };
}

function pred<T, R extends T>(predicate: (x: T) => x is R): (x: T) => x is R {
  return predicate;
}

function invariant(condition: boolean, path: NodePath): asserts condition {
  if (condition) return;
  throwErr(path);
}
function throwErr(path: NodePath): never {
  throw new Error(
    "\n" +
      "`mock` must be used like:\n\n" +
      "const { foo } = mock(import('moduleName'))\n\n" +
      "Instead saw:\n\n" +
      path.getSource() +
      "\n\n"
  );
}
