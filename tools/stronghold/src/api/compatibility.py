"""Understands compatibility of APIs."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
import dataclasses
import itertools
import pathlib

import api
import api.ast


def check(before: pathlib.Path, after: pathlib.Path) -> Sequence[Violation]:
    """Identifies API compatibility issues between two files."""
    before_api = api.ast.extract(before)
    after_api = api.ast.extract(after)

    violations = []
    for name, before_def in before_api.items():
        if any(token.startswith('_') for token in name.split('.')):
            continue

        after_def = after_api.get(name)
        if after_def is None:
            violations.append(Violation(name, 'function deleted'))
            continue

        # Let's refine some terminology. Parameters come in three flavors:
        #  * positional only
        #  * keyword only
        #  * flexible: may be provided positionally or via keyword
        #
        # Required parameter: a parameter that must be provided as an
        # argument by callers. In other words, the function does not
        # have a default value.
        #
        # Variadic parameters: additional arguments that may only be
        # provided positionally, traditionally specified as *args in a
        # function definition.
        #
        # Variadic keywords: additional arguments that may only be
        # provided by name, traditionally specified as **kwargs in a
        # function definition.

        violations += _check_by_name(name, before_def, after_def)
        violations += _check_by_position(name, before_def, after_def)
        violations += _check_variadic_parameters(name, before_def, after_def)

    return violations


@dataclasses.dataclass
class Violation:
    """Represents an API violation."""

    # The fully-qualified name of the function within the module.
    func: str
    # A description of the violation.
    message: str


def _check_by_name(
    func: str, before: api.Parameters, after: api.Parameters
) -> Iterable[Violation]:
    """Checks for violations among the named parameters."""
    for name, before_param in _named_parameters(before).items():
        assert before_param.name == name
        after_param = _named_parameters(after).get(name)
        if after_param is None:
            yield Violation(func, f'{name} was removed')
            continue
        assert after_param.name == name
        if before_param.position != after_param.position:
            yield Violation(
                func,
                f'the position of {name} moved from {before_param.position} to '
                f'{after_param.position}',
            )
        if not before_param.required and after_param.required:
            yield Violation(func, f'{name} became required')

    for name, after_param in _named_parameters(after).items():
        assert after_param.name == name
        if after_param.required and name not in _named_parameters(before):
            yield Violation(func, f'{name} was added and is required')


def _named_parameters(params: api.Parameters) -> Mapping[str, api.Parameter]:
    """Extracts the parameters that can be passed by name."""
    return (
        {param.name: param for param in params.parameters if param.keyword}
        if len(params.parameters) > 0
        else {}
    )


def _check_by_position(
    func: str, before: api.Parameters, after: api.Parameters
) -> Iterable[Violation]:
    """Checks for violations among the positional parameters."""
    before_params = [param for param in before.parameters if not param.keyword]
    after_params = [param for param in after.parameters if not param.keyword]

    if before_params == after_params:
        return []

    for i, (before_param, after_param) in enumerate(
        itertools.zip_longest(before_params, after_params)
    ):
        assert before_param is None or before_param.position == i
        assert after_param is None or after_param.position == i

        if before_param is None:
            assert after_param is not None
            if after_param.required:
                yield Violation(func, f'{after_param.name} was added and is required')
        elif after_param is None:
            assert before_param is not None
            yield Violation(func, f'{before_param.name} was removed')
        else:
            assert before_param is not None
            assert after_param is not None
            if before_param.name != after_param.name:
                yield Violation(
                    func, f'{before_param.name} was renamed to {after_param.name}'
                )
                continue
            if not before_param.required and after_param.required:
                yield Violation(func, f'{before_param.name} became required')

    # TODO support renaming parameters.
    # Positional parameters may be renamed, but may not be
    # reordered. For example, f(x, y) may be changed to f(x, z) but
    # may not be changed to f(y, x). The idea here is that if an
    # argument is renamed, it could theoretically have the same
    # semantics as before, but if it is reordered, we expect that the
    # semantics would remain bound to the names.


def _check_variadic_parameters(
    func: str, before: api.Parameters, after: api.Parameters
) -> Iterable[Violation]:
    """Checks that support for variadic parameters is not removed."""
    if before.variadic_args and not after.variadic_args:
        yield Violation(func, 'removed *varargs')
    if before.variadic_kwargs and not after.variadic_kwargs:
        yield Violation(func, 'removed **kwargs')
